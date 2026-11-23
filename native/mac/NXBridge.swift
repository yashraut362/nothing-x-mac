// nx-bridge: a tiny Bluetooth transport for Nothing X Mac.
//
// Finds a connected device and relays its control packets over stdio as JSON lines.
// Most models use RFCOMM. ProBluetooth handles the B192's GATT transport.
// It knows nothing about the earbud protocol itself; that lives in web/core/.
//
// stdout events:  {"type":"connected","name":"…","address":"…","modelId":"…"?}
//                 {"type":"data","hex":"55…"}
//                 {"type":"disconnected"}
//                 {"type":"log","message":"…"}
// stdin commands: {"type":"write","hex":"55…"}
//                 {"type":"quit"}   close the channel cleanly and exit
// EOF on stdin, SIGTERM, SIGINT and SIGHUP also close cleanly.

import Foundation
import IOBluetooth
import CoreBluetooth

// Nothing / CMF control service (SPP over RFCOMM).
let serviceUUIDBytes: [UInt8] = [
    0xAE, 0xAC, 0x4A, 0x03, 0xDF, 0xF5, 0x49, 0x8F,
    0x84, 0x3A, 0x34, 0x48, 0x7C, 0xF1, 0x33, 0xEB,
]
let scanInterval: TimeInterval = 3

// Google Fast Pair Message Stream (RFCOMM). On open the device sends a
// "Device Information / Model ID" message, which identifies the exact model
// and colour (e.g. 4DFC4A = CMF Neckband Pro, Orange).
let fastPairStreamUUIDBytes: [UInt8] = [
    0xDF, 0x21, 0xFE, 0x2C, 0x25, 0x15, 0x4F, 0xDB,
    0x88, 0x86, 0xF1, 0x2C, 0x4D, 0x67, 0x92, 0x7C,
]
let modelIDTimeout: TimeInterval = 1.5

// Opens the Fast Pair stream just long enough to read the model ID, then
// closes it. Calls `done` exactly once, with nil if the device has no such
// service or doesn't answer in time.
final class ModelIDReader: NSObject, IOBluetoothRFCOMMChannelDelegate {
    private var channel: IOBluetoothRFCOMMChannel?
    private var buffer = [UInt8]()
    private var done: ((String?) -> Void)?
    private var generation = 0
    private let uuid = IOBluetoothSDPUUID(bytes: fastPairStreamUUIDBytes, length: fastPairStreamUUIDBytes.count)

    func read(from device: IOBluetoothDevice, done: @escaping (String?) -> Void) {
        cancel() // a reconnect replaces any read still in progress
        generation += 1
        let current = generation
        buffer = []
        self.done = done
        var channelID: BluetoothRFCOMMChannelID = 0
        guard let record = device.getServiceRecord(for: uuid),
              record.getRFCOMMChannelID(&channelID) == kIOReturnSuccess,
              device.openRFCOMMChannelAsync(&channel, withChannelID: channelID, delegate: self) == kIOReturnSuccess
        else { return finish(nil) }
        DispatchQueue.main.asyncAfter(deadline: .now() + modelIDTimeout) { [weak self] in
            if self?.generation == current { self?.finish(nil) }
        }
    }

    func cancel() {
        done = nil
        finish(nil)
    }

    private func finish(_ modelID: String?) {
        if let channel {
            self.channel = nil
            channel.setDelegate(nil)
            channel.close()
        }
        let done = self.done
        self.done = nil
        done?(modelID)
    }

    // Messages: [group, code, length (2 bytes, big-endian), data…].
    // Model ID is group 0x03 (device information), code 0x01, 3 bytes.
    func rfcommChannelData(_ rfcommChannel: IOBluetoothRFCOMMChannel!,
                           data dataPointer: UnsafeMutableRawPointer!,
                           length dataLength: Int) {
        buffer += UnsafeBufferPointer(start: dataPointer.assumingMemoryBound(to: UInt8.self), count: dataLength)
        while buffer.count >= 4 {
            let length = Int(buffer[2]) << 8 | Int(buffer[3])
            guard buffer.count >= 4 + length else { return }
            let message = Array(buffer[0..<(4 + length)])
            buffer.removeFirst(4 + length)
            if message[0] == 0x03, message[1] == 0x01, length == 3 {
                return finish(message[4...].map { String(format: "%02X", $0) }.joined())
            }
        }
        if buffer.count > 512 { finish(nil) } // not a message stream after all
    }

    func rfcommChannelClosed(_ rfcommChannel: IOBluetoothRFCOMMChannel!) {
        guard rfcommChannel === channel else { return }
        channel = nil
        finish(nil)
    }
}

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func log(_ message: String) { emit(["type": "log", "message": message]) }

func hexString(_ bytes: UnsafeBufferPointer<UInt8>) -> String {
    bytes.map { String(format: "%02x", $0) }.joined()
}

func bytes(fromHex hex: String) -> [UInt8]? {
    guard hex.count % 2 == 0 else { return nil }
    var out = [UInt8]()
    out.reserveCapacity(hex.count / 2)
    var index = hex.startIndex
    while index < hex.endIndex {
        let next = hex.index(index, offsetBy: 2)
        guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
        out.append(byte)
        index = next
    }
    return out
}

final class Bridge: NSObject, IOBluetoothRFCOMMChannelDelegate {
    private var channel: IOBluetoothRFCOMMChannel?
    private var device: IOBluetoothDevice?
    private var sdpRequested = Set<String>()
    private var openFailures: [String: Int] = [:]
    private var linkResetDone = Set<String>()
    private var shuttingDown = false
    private var scanSummary = ""
    private let pro = ProBluetooth()
    private let modelReader = ModelIDReader()
    // Fast Pair model ID per device address, read once per run. Read BEFORE
    // the control channel opens: opening and closing the Fast Pair channel
    // while the control channel is open breaks writes on the CMF Neckband Pro.
    // A nil value means "read, but no ID" so it isn't retried.
    private var modelIDs: [String: String?] = [:]
    private var identifying = false
    private let serviceUUID = IOBluetoothSDPUUID(bytes: serviceUUIDBytes, length: serviceUUIDBytes.count)

    func start() {
        scan()
        Timer.scheduledTimer(withTimeInterval: scanInterval, repeats: true) { [weak self] _ in
            self?.scan()
        }
    }

    // Look for a connected paired device that offers the control service.
    private func scan() {
        guard channel == nil, !shuttingDown, !identifying else { return }
        let paired = IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice] ?? []
        if ProcessInfo.processInfo.environment["NXM_DEBUG"] != nil {
            let connected = paired.filter { $0.isConnected() }.count
            let summary = "Bluetooth authorization \(CBManager.authorization.rawValue), paired \(paired.count), connected \(connected)"
            if summary != scanSummary {
                log(summary)
                scanSummary = summary
            }
        }

        let connected = paired.filter { $0.isConnected() }
        let names = Set(connected.compactMap { $0.name })
        // An established LE link is the control channel: only keep it alive.
        // An LE attempt still in flight must not hold up the classic scan
        // below, or ordinary earbuds would wait on it before reconnecting.
        if pro.connected {
            pro.scan(connectedNames: names)
            return
        }
        for candidate in connected {
            guard let record = candidate.getServiceRecord(for: serviceUUID) else {
                // Service list not cached yet: ask once, pick it up on a later scan.
                let address = candidate.addressString ?? ""
                if !sdpRequested.contains(address) {
                    sdpRequested.insert(address)
                    let status = candidate.performSDPQuery(nil)
                    if ProcessInfo.processInfo.environment["NXM_DEBUG"] != nil {
                        log("Refreshing Bluetooth services (\(describe(status)))")
                    }
                }
                continue
            }

            var channelID: BluetoothRFCOMMChannelID = 0
            guard record.getRFCOMMChannelID(&channelID) == kIOReturnSuccess else { continue }

            let address = candidate.addressString ?? ""
            if modelIDs[address] == nil {
                // Identify first, then come back here to open the control channel.
                identifying = true
                modelReader.read(from: candidate) { [weak self] modelID in
                    guard let self else { return }
                    self.modelIDs[address] = .some(modelID)
                    // Let the Fast Pair channel finish closing before the next
                    // open; stay `identifying` so the scan timer waits too.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        self.identifying = false
                        if !self.shuttingDown { self.scan() }
                    }
                }
                return
            }

            var opened: IOBluetoothRFCOMMChannel?
            let status = candidate.openRFCOMMChannelSync(&opened, withChannelID: channelID, delegate: self)
            guard status == kIOReturnSuccess, let opened else {
                handleOpenFailure(candidate, address: address, status: status)
                continue
            }

            openFailures[address] = 0
            // This device uses the classic channel: drop any LE attempt in flight.
            pro.close()
            channel = opened
            device = candidate
            var message: [String: Any] = [
                "type": "connected",
                "name": candidate.name ?? candidate.nameOrAddress ?? "Earbuds",
                "address": address,
            ]
            if let modelID = modelIDs[address] ?? nil { message["modelId"] = modelID }
            emit(message)
            return
        }
        pro.scan(connectedNames: names)
    }

    // Opening usually fails because the earbuds still hold a channel from an
    // earlier session that never closed it. Recover in two steps:
    //   1st failure: refresh the service record in case the channel id moved.
    //   3rd failure: drop and re-establish the Bluetooth link once, which makes
    //                the earbuds forget the stale channel (brief audio blip).
    private func handleOpenFailure(_ device: IOBluetoothDevice, address: String, status: IOReturn) {
        let attempt = (openFailures[address] ?? 0) + 1
        openFailures[address] = attempt
        let name = device.nameOrAddress ?? "device"
        log("Could not open channel to \(name) (\(describe(status))), attempt \(attempt)")

        if attempt == 1 {
            device.performSDPQuery(nil)
        }
        if attempt == 3 && !linkResetDone.contains(address) {
            linkResetDone.insert(address)
            log("Resetting Bluetooth link to \(name) to clear a stale channel")
            device.closeConnection()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                _ = device.openConnection()
            }
        }
    }

    // Close the channel properly so the earbuds accept a new one next launch.
    func shutdown() {
        guard !shuttingDown else { return }
        shuttingDown = true
        modelReader.cancel()
        pro.close()
        if let channel {
            self.channel = nil
            channel.setDelegate(nil)
            channel.close()
        }
        // Give the Bluetooth stack a moment to send the disconnect.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
    }

    func write(hex: String) {
        guard var data = bytes(fromHex: hex), !data.isEmpty else { return }
        if pro.connected { pro.write(data); return }
        guard let channel else { return }
        let status = data.withUnsafeMutableBytes { buffer in
            channel.writeSync(buffer.baseAddress, length: UInt16(buffer.count))
        }
        if status != kIOReturnSuccess { log("Write failed (\(status))") }
    }

    // MARK: IOBluetoothRFCOMMChannelDelegate

    func rfcommChannelData(_ rfcommChannel: IOBluetoothRFCOMMChannel!,
                           data dataPointer: UnsafeMutableRawPointer!,
                           length dataLength: Int) {
        let buffer = UnsafeBufferPointer(start: dataPointer.assumingMemoryBound(to: UInt8.self),
                                         count: dataLength)
        emit(["type": "data", "hex": hexString(buffer)])
    }

    func rfcommChannelClosed(_ rfcommChannel: IOBluetoothRFCOMMChannel!) {
        guard rfcommChannel === channel else { return }
        channel = nil
        device = nil
        emit(["type": "disconnected"])
    }
}

func describe(_ status: IOReturn) -> String {
    let code = String(format: "0x%08X", UInt32(bitPattern: status))
    switch status {
    case kIOReturnError: return "\(code) general error"
    case kIOReturnBusy: return "\(code) busy"
    case kIOReturnTimeout: return "\(code) timeout"
    case kIOReturnNotOpen: return "\(code) not open"
    case kIOReturnNoDevice: return "\(code) no device"
    default: return code
    }
}

let bridge = Bridge()

// Quit cleanly on signals (app quit, Ctrl-C, terminal closed).
var signalSources: [DispatchSourceSignal] = []
// A pipe read can end in the middle of a JSON command. Process complete lines on the main queue.
var pendingInput = Data()
func consumeInput(_ chunk: Data) {
    pendingInput.append(chunk)
    while let newline = pendingInput.firstIndex(of: 0x0a) {
        let line = pendingInput[..<newline]
        pendingInput.removeSubrange(...newline)
        guard let json = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
        if json["type"] as? String == "quit" { bridge.shutdown(); return }
        if json["type"] as? String == "write", let hex = json["hex"] as? String { bridge.write(hex: hex) }
    }
}

@main
enum NXBridgeMain {
    static func main() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { bridge.shutdown() }
            source.resume()
            signalSources.append(source)
        }

        FileHandle.standardInput.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                DispatchQueue.main.async { bridge.shutdown() }
                return
            }
            DispatchQueue.main.async { consumeInput(chunk) }
        }

        bridge.start()
        RunLoop.main.run()
    }
}
