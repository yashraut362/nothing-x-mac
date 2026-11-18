// nx-bridge: a tiny Bluetooth transport for Nothing X Mac.
//
// Finds a connected, paired earbud that exposes the Nothing control service,
// opens an RFCOMM channel to it, and relays raw bytes over stdio as JSON lines.
// It knows nothing about the earbud protocol itself; that lives in src/device/.
//
// stdout events:  {"type":"connected","name":"…","address":"…"}
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

// Newer models (e.g. Headphone (1) Pro) don't offer the SPP service above.
// They carry the same 0x55-framed protocol over a BLE GATT service instead:
// commands are written to one characteristic, replies arrive as notifications.
let bleServiceUUID = CBUUID(string: "FD90")
let bleWriteUUID = CBUUID(string: "68745353-1810-4B13-83A2-C1B21B652C9B")
let bleNotifyUUID = CBUUID(string: "CA235943-1810-45E6-8326-FC8CA3BC45CE")

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

// Control link over BLE GATT for models without the SPP service.
final class BLELink: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var writeChar: CBCharacteristic?
    private(set) var isReady = false
    var onConnected: ((String, String) -> Void)?
    var onData: ((Data) -> Void)?
    var onDisconnected: (() -> Void)?

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    var isBusy: Bool { peripheral != nil }

    // Pick up headphones already connected to the Mac that offer the service.
    func tryConnect() {
        guard central.state == .poweredOn, peripheral == nil else { return }
        guard let found = central.retrieveConnectedPeripherals(withServices: [bleServiceUUID]).first else { return }
        peripheral = found
        found.delegate = self
        central.connect(found)
    }

    func write(_ data: Data) {
        guard isReady, let peripheral, let writeChar else { return }
        let type: CBCharacteristicWriteType =
            writeChar.properties.contains(.write) ? .withResponse : .withoutResponse
        let chunkSize = max(20, peripheral.maximumWriteValueLength(for: type))
        var offset = 0
        while offset < data.count {
            let end = min(offset + chunkSize, data.count)
            peripheral.writeValue(data.subdata(in: offset..<end), for: writeChar, type: type)
            offset = end
        }
    }

    // Only drops this app's use of the link; the audio connection stays up.
    func disconnect() {
        if let peripheral { central.cancelPeripheralConnection(peripheral) }
        reset()
    }

    private func reset() {
        peripheral = nil
        writeChar = nil
        isReady = false
    }

    // MARK: CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .unauthorized { log("Bluetooth LE access not authorized") }
        if central.state != .poweredOn, peripheral != nil {
            let wasReady = isReady
            reset()
            if wasReady { onDisconnected?() }
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([bleServiceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        log("BLE connect failed: \(error?.localizedDescription ?? "unknown")")
        reset()
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard peripheral === self.peripheral else { return }
        let wasReady = isReady
        reset()
        if wasReady { onDisconnected?() }
    }

    // MARK: CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == bleServiceUUID }) else {
            log("BLE control service missing")
            disconnect()
            return
        }
        peripheral.discoverCharacteristics([bleWriteUUID, bleNotifyUUID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        let chars = service.characteristics ?? []
        guard let write = chars.first(where: { $0.uuid == bleWriteUUID }),
              let notify = chars.first(where: { $0.uuid == bleNotifyUUID }) else {
            log("BLE control characteristics missing")
            disconnect()
            return
        }
        writeChar = write
        peripheral.setNotifyValue(true, for: notify)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == bleNotifyUUID else { return }
        if let error {
            log("BLE notify failed: \(error.localizedDescription)")
            disconnect()
            return
        }
        guard !isReady else { return }
        isReady = true
        onConnected?(peripheral.name ?? "Headphones", peripheral.identifier.uuidString)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == bleNotifyUUID, let value = characteristic.value, !value.isEmpty else { return }
        onData?(value)
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error { log("BLE write failed: \(error.localizedDescription)") }
    }
}

final class Bridge: NSObject, IOBluetoothRFCOMMChannelDelegate {
    private var channel: IOBluetoothRFCOMMChannel?
    private var device: IOBluetoothDevice?
    private var sdpRequested = Set<String>()
    private var openFailures: [String: Int] = [:]
    private var linkResetDone = Set<String>()
    private var shuttingDown = false
    private let serviceUUID = IOBluetoothSDPUUID(bytes: serviceUUIDBytes, length: 16)
    private let ble = BLELink()

    override init() {
        super.init()
        ble.onConnected = { name, id in
            emit(["type": "connected", "name": name, "address": id])
        }
        ble.onData = { data in
            data.withUnsafeBytes { raw in
                emit(["type": "data", "hex": hexString(raw.bindMemory(to: UInt8.self))])
            }
        }
        ble.onDisconnected = { emit(["type": "disconnected"]) }
    }

    func start() {
        scan()
        Timer.scheduledTimer(withTimeInterval: scanInterval, repeats: true) { [weak self] _ in
            self?.scan()
        }
    }

    // Look for a connected paired device that offers the control service.
    private func scan() {
        guard channel == nil, !ble.isBusy, !shuttingDown else { return }
        guard let paired = IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice] else {
            ble.tryConnect()
            return
        }

        for candidate in paired where candidate.isConnected() {
            guard let record = candidate.getServiceRecord(for: serviceUUID) else {
                // Service list not cached yet: ask once, pick it up on a later scan.
                let address = candidate.addressString ?? ""
                if !sdpRequested.contains(address) {
                    sdpRequested.insert(address)
                    candidate.performSDPQuery(nil)
                }
                continue
            }

            var channelID: BluetoothRFCOMMChannelID = 0
            guard record.getRFCOMMChannelID(&channelID) == kIOReturnSuccess else { continue }

            let address = candidate.addressString ?? ""
            var opened: IOBluetoothRFCOMMChannel?
            let status = candidate.openRFCOMMChannelSync(&opened, withChannelID: channelID, delegate: self)
            guard status == kIOReturnSuccess, let opened else {
                handleOpenFailure(candidate, address: address, status: status)
                continue
            }

            openFailures[address] = 0
            channel = opened
            device = candidate
            emit([
                "type": "connected",
                "name": candidate.name ?? candidate.nameOrAddress ?? "Earbuds",
                "address": candidate.addressString ?? "",
            ])
            return
        }

        // No connected device offers the SPP service: try the BLE control link.
        ble.tryConnect()
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
        if let channel {
            self.channel = nil
            channel.setDelegate(nil)
            channel.close()
        }
        ble.disconnect()
        // Give the Bluetooth stack a moment to send the disconnect.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
    }

    func write(hex: String) {
        guard var data = bytes(fromHex: hex), !data.isEmpty else { return }
        guard let channel else {
            ble.write(Data(data))
            return
        }
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
for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { bridge.shutdown() }
    source.resume()
    signalSources.append(source)
}

// Read commands from stdin; shut down when asked or when the app goes away (EOF).
FileHandle.standardInput.readabilityHandler = { handle in
    let chunk = handle.availableData
    if chunk.isEmpty {
        handle.readabilityHandler = nil
        DispatchQueue.main.async { bridge.shutdown() }
        return
    }
    guard let text = String(data: chunk, encoding: .utf8) else { return }
    for line in text.split(separator: "\n") {
        guard
            let json = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
            let type = json["type"] as? String
        else { continue }
        switch type {
        case "write":
            if let hex = json["hex"] as? String {
                DispatchQueue.main.async { bridge.write(hex: hex) }
            }
        case "quit":
            DispatchQueue.main.async { bridge.shutdown() }
        default:
            break
        }
    }
}

bridge.start()
RunLoop.main.run()
