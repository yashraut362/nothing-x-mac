// A setting change that isn't final until the earbuds confirm it.
//
// After a change is sent, the earbuds may keep reporting the old value for a
// moment. While a change is pending, reports that don't match the target are
// ignored and the value is read again shortly. If no confirmation arrives in
// time, the pending state is dropped and the next report is trusted.

const FIRST_READ_MS = 150;
const RETRY_MS = 400;
const TIMEOUT_MS = 4_000;

class ConfirmedSetting {
  // read():                 ask the earbuds for the current value
  // matches(report, target): does a report confirm the target?
  // onTimeout():             called when confirmation never came
  constructor({ read, matches, onTimeout = () => {} }) {
    this.read = read;
    this.matches = matches;
    this.onTimeout = onTimeout;
    this.target = null;
    this.readTimer = null;
    this.timeoutTimer = null;
  }

  get pending() {
    return this.target !== null;
  }

  begin(target) {
    this.target = target;
    this.#scheduleRead(FIRST_READ_MS);
    clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => {
      if (!this.pending) return;
      this.reset();
      this.onTimeout();
      this.read(); // show whatever the earbuds settled on
    }, TIMEOUT_MS);
  }

  // Returns true if the report should be applied to state.
  accept(report) {
    if (!this.pending) return true;
    if (this.matches(report, this.target)) {
      this.reset();
      return true;
    }
    this.#scheduleRead(RETRY_MS); // still switching; ask again shortly
    return false;
  }

  reset() {
    this.target = null;
    clearTimeout(this.readTimer);
    clearTimeout(this.timeoutTimer);
    this.readTimer = null;
    this.timeoutTimer = null;
  }

  #scheduleRead(delay) {
    clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => this.read(), delay);
  }
}

export { ConfirmedSetting };
