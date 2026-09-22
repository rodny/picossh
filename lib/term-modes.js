// Follows the terminal modes a program switches with DECSET/DECRST (mouse
// reporting, the alternate screen, application cursor keys, bracketed paste)
// and the keypad mode, so a replay that starts after the program set them can
// set them again. Without that, a resumed page holds a freshly reset terminal
// that no longer reports clicks to the program on screen.

const TRACKED = new Set([
  1,                      // application cursor keys
  7, 25,                  // autowrap, cursor visible (both on by default)
  47, 1047, 1049,         // alternate screen
  9, 1000, 1002, 1003,    // mouse tracking
  1004,                   // focus events
  1005, 1006, 1015, 1016, // mouse encodings
  2004,                   // bracketed paste
]);
const DEFAULT_ON = new Set([7, 25]);
const ALTERNATE = [47, 1047, 1049];
// Turning any tracking mode off turns mouse tracking off.
const MOUSE_TRACKING = [9, 1000, 1002, 1003];
const MAX_CSI = 64;

const GROUND = 0, ESC = 1, CSI = 2;

class TermModes {
  constructor() {
    this.modes = new Map(); // mode -> on, in the order they last changed
    this.state = GROUND;
    this.csi = '';
  }

  clone() {
    const copy = new TermModes();
    copy.modes = new Map(this.modes);
    copy.state = this.state;
    copy.csi = this.csi;
    return copy;
  }

  // Part way through an escape sequence, so the next bytes are not text.
  get inSequence() {
    return this.state !== GROUND;
  }

  set(mode, on) {
    this.modes.delete(mode);
    this.modes.set(mode, on);
  }

  decset(params, on) {
    for (const p of params.split(';')) {
      const mode = Number(p);
      if (!TRACKED.has(mode)) continue;
      if (!on && MOUSE_TRACKING.includes(mode)) for (const m of MOUSE_TRACKING) this.set(m, false);
      else this.set(mode, on);
    }
  }

  // Output bytes from the program, in order; sequences may span calls.
  feed(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 0x1b) {
        this.state = ESC;
        continue;
      }
      if (this.state === ESC) {
        this.state = GROUND;
        if (b === 0x5b) { // [
          this.state = CSI;
          this.csi = '';
        } else if (b === 0x3d) this.set('keypad', true); // =
        else if (b === 0x3e) this.set('keypad', false); // >
        else if (b === 0x63) this.modes.clear(); // c: full reset
      } else if (this.state === CSI) {
        if (b >= 0x40 && b <= 0x7e) {
          this.state = GROUND;
          if ((b === 0x68 || b === 0x6c) && this.csi[0] === '?') this.decset(this.csi.slice(1), b === 0x68);
        } else if (b < 0x20 || this.csi.length >= MAX_CSI) {
          this.state = GROUND; // not a sequence after all
        } else {
          this.csi += String.fromCharCode(b);
        }
      }
    }
  }

  // A full-screen program (htop, vim, less) is on screen: the last of the
  // alternate screen switches to change turned it on.
  get alternateScreen() {
    let on = false;
    for (const [mode, value] of this.modes) if (ALTERNATE.includes(mode)) on = value;
    return on;
  }

  // Bytes that put a reset terminal into the tracked modes. A mode already at
  // its default is left out, except an alternate screen switch turned off
  // after a different one turned it on: told only about the "on", a reset
  // terminal would be left on an alternate screen the program has left.
  restore() {
    let out = '';
    let alternate = false; // what the sequences so far leave on screen
    for (const [mode, on] of this.modes) {
      if (mode === 'keypad') {
        if (on) out += '\x1b=';
      } else if (on !== DEFAULT_ON.has(mode) || (alternate && ALTERNATE.includes(mode))) {
        out += `\x1b[?${mode}${on ? 'h' : 'l'}`;
        if (ALTERNATE.includes(mode)) alternate = on;
      }
    }
    return out;
  }
}

module.exports = { TermModes };
