"use strict";

Object.defineProperty(exports, "__esModule", {
    value: true
});

var _keysym = require("./keysym");

var _keysym2 = _interopRequireDefault(_keysym);

var _keysymdef = require("./keysymdef");

var _keysymdef2 = _interopRequireDefault(_keysymdef);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var KeyboardUtil = {};

(function () {
    "use strict";

    function substituteCodepoint(cp) {
        // Any Unicode code points which do not have corresponding keysym entries
        // can be swapped out for another code point by adding them to this table
        var substitutions = {
            // {S,s} with comma below -> {S,s} with cedilla
            0x218: 0x15e,
            0x219: 0x15f,
            // {T,t} with comma below -> {T,t} with cedilla
            0x21a: 0x162,
            0x21b: 0x163
        };

        var sub = substitutions[cp];
        return sub ? sub : cp;
    }

    function isMac() {
        return navigator && !!/mac/i.exec(navigator.platform);
    }
    function isWindows() {
        return navigator && !!/win/i.exec(navigator.platform);
    }
    function isLinux() {
        return navigator && !!/linux/i.exec(navigator.platform);
    }

    // Return true if a modifier which is not the specified char modifier (and is not shift) is down
    function hasShortcutModifier(charModifier, currentModifiers) {
        var mods = {};
        for (var key in currentModifiers) {
            if (parseInt(key) !== _keysym2.default.XK_Shift_L) {
                mods[key] = currentModifiers[key];
            }
        }

        var sum = 0;
        for (var k in currentModifiers) {
            if (mods[k]) {
                ++sum;
            }
        }
        if (hasCharModifier(charModifier, mods)) {
            return sum > charModifier.length;
        } else {
            return sum > 0;
        }
    }

    // Return true if the specified char modifier is currently down
    function hasCharModifier(charModifier, currentModifiers) {
        if (charModifier.length === 0) {
            return false;
        }

        for (var i = 0; i < charModifier.length; ++i) {
            if (!currentModifiers[charModifier[i]]) {
                return false;
            }
        }
        return true;
    }

    // Helper object tracking modifier key state
    // and generates fake key events to compensate if it gets out of sync
    function ModifierSync(charModifier) {
        if (!charModifier) {
            if (isMac()) {
                // on Mac, Option (AKA Alt) is used as a char modifier
                charModifier = [_keysym2.default.XK_Alt_L];
            } else if (isWindows()) {
                // on Windows, Ctrl+Alt is used as a char modifier
                charModifier = [_keysym2.default.XK_Alt_L, _keysym2.default.XK_Control_L];
            } else if (isLinux()) {
                // on Linux, ISO Level 3 Shift (AltGr) is used as a char modifier
                charModifier = [_keysym2.default.XK_ISO_Level3_Shift];
            } else {
                charModifier = [];
            }
        }

        var state = {};
        state[_keysym2.default.XK_Control_L] = false;
        state[_keysym2.default.XK_Alt_L] = false;
        state[_keysym2.default.XK_ISO_Level3_Shift] = false;
        state[_keysym2.default.XK_Shift_L] = false;
        state[_keysym2.default.XK_Meta_L] = false;

        function sync(evt, keysym) {
            var result = [];
            function syncKey(keysym) {
                return { keysym: _keysymdef2.default.lookup(keysym), type: state[keysym] ? 'keydown' : 'keyup' };
            }

            if (evt.ctrlKey !== undefined && evt.ctrlKey !== state[_keysym2.default.XK_Control_L] && keysym !== _keysym2.default.XK_Control_L) {
                state[_keysym2.default.XK_Control_L] = evt.ctrlKey;
                result.push(syncKey(_keysym2.default.XK_Control_L));
            }
            if (evt.altKey !== undefined && evt.altKey !== state[_keysym2.default.XK_Alt_L] && keysym !== _keysym2.default.XK_Alt_L) {
                state[_keysym2.default.XK_Alt_L] = evt.altKey;
                result.push(syncKey(_keysym2.default.XK_Alt_L));
            }
            if (evt.altGraphKey !== undefined && evt.altGraphKey !== state[_keysym2.default.XK_ISO_Level3_Shift] && keysym !== _keysym2.default.XK_ISO_Level3_Shift) {
                state[_keysym2.default.XK_ISO_Level3_Shift] = evt.altGraphKey;
                result.push(syncKey(_keysym2.default.XK_ISO_Level3_Shift));
            }
            if (evt.shiftKey !== undefined && evt.shiftKey !== state[_keysym2.default.XK_Shift_L] && keysym !== _keysym2.default.XK_Shift_L) {
                state[_keysym2.default.XK_Shift_L] = evt.shiftKey;
                result.push(syncKey(_keysym2.default.XK_Shift_L));
            }
            if (evt.metaKey !== undefined && evt.metaKey !== state[_keysym2.default.XK_Meta_L] && keysym !== _keysym2.default.XK_Meta_L) {
                state[_keysym2.default.XK_Meta_L] = evt.metaKey;
                result.push(syncKey(_keysym2.default.XK_Meta_L));
            }
            return result;
        }
        function syncKeyEvent(evt, down) {
            var obj = getKeysym(evt);
            var keysym = obj ? obj.keysym : null;

            // first, apply the event itself, if relevant
            if (keysym !== null && state[keysym] !== undefined) {
                state[keysym] = down;
            }
            return sync(evt, keysym);
        }

        return {
            // sync on the appropriate keyboard event
            keydown: function (evt) {
                return syncKeyEvent(evt, true);
            },
            keyup: function (evt) {
                return syncKeyEvent(evt, false);
            },
            // Call this with a non-keyboard event (such as mouse events) to use its modifier state to synchronize anyway
            syncAny: function (evt) {
                return sync(evt);
            },

            // is a shortcut modifier down?
            hasShortcutModifier: function () {
                return hasShortcutModifier(charModifier, state);
            },
            // if a char modifier is down, return the keys it consists of, otherwise return null
            activeCharModifier: function () {
                return hasCharModifier(charModifier, state) ? charModifier : null;
            }
        };
    }

    // Get a key ID from a keyboard event
    // May be a string or an integer depending on the available properties
    function getKey(evt) {
        if ('keyCode' in evt && 'key' in evt) {
            return evt.key + ':' + evt.keyCode;
        } else if ('keyCode' in evt) {
            return evt.keyCode;
        } else {
            return evt.key;
        }
    }

    // Get the most reliable keysym value we can get from a key event
    // if char/charCode is available, prefer those, otherwise fall back to key/keyCode/which
    function getKeysym(evt) {
        var codepoint;
        if (evt.char && evt.char.length === 1) {
            codepoint = evt.char.charCodeAt();
        } else if (evt.charCode) {
            codepoint = evt.charCode;
        } else if (evt.keyCode && evt.type === 'keypress') {
            // IE10 stores the char code as keyCode, and has no other useful properties
            codepoint = evt.keyCode;
        }
        if (codepoint) {
            var res = _keysymdef2.default.fromUnicode(substituteCodepoint(codepoint));
            if (res) {
                return res;
            }
        }
        // we could check evt.key here.
        // Legal values are defined in http://www.w3.org/TR/DOM-Level-3-Events/#key-values-list,
        // so we "just" need to map them to keysym, but AFAIK this is only available in IE10, which also provides evt.key
        // so we don't *need* it yet
        if (evt.keyCode) {
            return _keysymdef2.default.lookup(keysymFromKeyCode(evt.keyCode, evt.shiftKey));
        }
        if (evt.which) {
            return _keysymdef2.default.lookup(keysymFromKeyCode(evt.which, evt.shiftKey));
        }
        return null;
    }

    // Given a keycode, try to predict which keysym it might be.
    // If the keycode is unknown, null is returned.
    function keysymFromKeyCode(keycode, shiftPressed) {
        if (typeof keycode !== 'number') {
            return null;
        }
        // won't be accurate for azerty
        if (keycode >= 0x30 && keycode <= 0x39) {
            return keycode; // digit
        }
        if (keycode >= 0x41 && keycode <= 0x5a) {
            // remap to lowercase unless shift is down
            return shiftPressed ? keycode : keycode + 32; // A-Z
        }
        if (keycode >= 0x60 && keycode <= 0x69) {
            return _keysym2.default.XK_KP_0 + (keycode - 0x60); // numpad 0-9
        }

        switch (keycode) {
            case 0x20:
                return _keysym2.default.XK_space;
            case 0x6a:
                return _keysym2.default.XK_KP_Multiply;
            case 0x6b:
                return _keysym2.default.XK_KP_Add;
            case 0x6c:
                return _keysym2.default.XK_KP_Separator;
            case 0x6d:
                return _keysym2.default.XK_KP_Subtract;
            case 0x6e:
                return _keysym2.default.XK_KP_Decimal;
            case 0x6f:
                return _keysym2.default.XK_KP_Divide;
            case 0xbb:
                return _keysym2.default.XK_plus;
            case 0xbc:
                return _keysym2.default.XK_comma;
            case 0xbd:
                return _keysym2.default.XK_minus;
            case 0xbe:
                return _keysym2.default.XK_period;
        }

        return nonCharacterKey({ keyCode: keycode });
    }

    // if the key is a known non-character key (any key which doesn't generate character data)
    // return its keysym value. Otherwise return null
    function nonCharacterKey(evt) {
        // evt.key not implemented yet
        if (!evt.keyCode) {
            return null;
        }
        var keycode = evt.keyCode;

        if (keycode >= 0x70 && keycode <= 0x87) {
            return _keysym2.default.XK_F1 + keycode - 0x70; // F1-F24
        }
        switch (keycode) {

            case 8:
                return _keysym2.default.XK_BackSpace;
            case 13:
                return _keysym2.default.XK_Return;

            case 9:
                return _keysym2.default.XK_Tab;

            case 27:
                return _keysym2.default.XK_Escape;
            case 46:
                return _keysym2.default.XK_Delete;

            case 36:
                return _keysym2.default.XK_Home;
            case 35:
                return _keysym2.default.XK_End;
            case 33:
                return _keysym2.default.XK_Page_Up;
            case 34:
                return _keysym2.default.XK_Page_Down;
            case 45:
                return _keysym2.default.XK_Insert;

            case 37:
                return _keysym2.default.XK_Left;
            case 38:
                return _keysym2.default.XK_Up;
            case 39:
                return _keysym2.default.XK_Right;
            case 40:
                return _keysym2.default.XK_Down;

            case 16:
                return _keysym2.default.XK_Shift_L;
            case 17:
                return _keysym2.default.XK_Control_L;
            case 18:
                return _keysym2.default.XK_Alt_L; // also: Option-key on Mac

            case 224:
                return _keysym2.default.XK_Meta_L;
            case 225:
                return _keysym2.default.XK_ISO_Level3_Shift; // AltGr
            case 91:
                return _keysym2.default.XK_Super_L; // also: Windows-key
            case 92:
                return _keysym2.default.XK_Super_R; // also: Windows-key
            case 93:
                return _keysym2.default.XK_Menu; // also: Windows-Menu, Command on Mac
            default:
                return null;
        }
    }

    KeyboardUtil.hasShortcutModifier = hasShortcutModifier;
    KeyboardUtil.hasCharModifier = hasCharModifier;
    KeyboardUtil.ModifierSync = ModifierSync;
    KeyboardUtil.getKey = getKey;
    KeyboardUtil.getKeysym = getKeysym;
    KeyboardUtil.keysymFromKeyCode = keysymFromKeyCode;
    KeyboardUtil.nonCharacterKey = nonCharacterKey;
    KeyboardUtil.substituteCodepoint = substituteCodepoint;
})();

KeyboardUtil.QEMUKeyEventDecoder = function (modifierState, next) {
    "use strict";

    function sendAll(evts) {
        for (var i = 0; i < evts.length; ++i) {
            next(evts[i]);
        }
    }

    var numPadCodes = ["Numpad0", "Numpad1", "Numpad2", "Numpad3", "Numpad4", "Numpad5", "Numpad6", "Numpad7", "Numpad8", "Numpad9", "NumpadDecimal"];

    var numLockOnKeySyms = {
        "Numpad0": 0xffb0, "Numpad1": 0xffb1, "Numpad2": 0xffb2,
        "Numpad3": 0xffb3, "Numpad4": 0xffb4, "Numpad5": 0xffb5,
        "Numpad6": 0xffb6, "Numpad7": 0xffb7, "Numpad8": 0xffb8,
        "Numpad9": 0xffb9, "NumpadDecimal": 0xffac
    };

    var numLockOnKeyCodes = [96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 108, 110];

    function isNumPadMultiKey(evt) {
        return numPadCodes.indexOf(evt.code) !== -1;
    }

    function getNumPadKeySym(evt) {
        if (numLockOnKeyCodes.indexOf(evt.keyCode) !== -1) {
            return numLockOnKeySyms[evt.code];
        }
        return 0;
    }

    function process(evt, type) {
        var result = { type: type };
        result.code = evt.code;
        result.keysym = 0;

        if (isNumPadMultiKey(evt)) {
            result.keysym = getNumPadKeySym(evt);
        }

        var hasModifier = modifierState.hasShortcutModifier() || !!modifierState.activeCharModifier();
        var isShift = evt.keyCode === 0x10 || evt.key === 'Shift';

        var suppress = !isShift && (type !== 'keydown' || modifierState.hasShortcutModifier() || !!KeyboardUtil.nonCharacterKey(evt));

        next(result);
        return suppress;
    }
    return {
        keydown: function (evt) {
            sendAll(modifierState.keydown(evt));
            return process(evt, 'keydown');
        },
        keypress: function (evt) {
            return true;
        },
        keyup: function (evt) {
            sendAll(modifierState.keyup(evt));
            return process(evt, 'keyup');
        },
        syncModifiers: function (evt) {
            sendAll(modifierState.syncAny(evt));
        },
        releaseAll: function () {
            next({ type: 'releaseall' });
        }
    };
};

KeyboardUtil.TrackQEMUKeyState = function (next) {
    "use strict";

    var state = [];

    return function (evt) {
        var last = state.length !== 0 ? state[state.length - 1] : null;

        switch (evt.type) {
            case 'keydown':

                if (!last || last.code !== evt.code) {
                    last = { code: evt.code };

                    if (state.length > 0 && state[state.length - 1].code == 'ControlLeft') {
                        if (evt.code !== 'AltRight') {
                            next({ code: 'ControlLeft', type: 'keydown', keysym: 0 });
                        } else {
                            state.pop();
                        }
                    }
                    state.push(last);
                }
                if (evt.code !== 'ControlLeft') {
                    next(evt);
                }
                break;

            case 'keyup':
                if (state.length === 0) {
                    return;
                }
                var idx = null;
                // do we have a matching key tracked as being down?
                for (var i = 0; i !== state.length; ++i) {
                    if (state[i].code === evt.code) {
                        idx = i;
                        break;
                    }
                }
                // if we couldn't find a match (it happens), assume it was the last key pressed
                if (idx === null) {
                    if (evt.code === 'ControlLeft') {
                        return;
                    }
                    idx = state.length - 1;
                }

                state.splice(idx, 1);
                next(evt);
                break;
            case 'releaseall':
                /* jshint shadow: true */
                for (var i = 0; i < state.length; ++i) {
                    next({ code: state[i].code, keysym: 0, type: 'keyup' });
                }
                /* jshint shadow: false */
                state = [];
        }
    };
};

// Takes a DOM keyboard event and:
// - determines which keysym it represents
// - determines a keyId  identifying the key that was pressed (corresponding to the key/keyCode properties on the DOM event)
// - synthesizes events to synchronize modifier key state between which modifiers are actually down, and which we thought were down
// - marks each event with an 'escape' property if a modifier was down which should be "escaped"
// - generates a "stall" event in cases where it might be necessary to wait and see if a keypress event follows a keydown
// This information is collected into an object which is passed to the next() function. (one call per event)
KeyboardUtil.KeyEventDecoder = function (modifierState, next) {
    "use strict";

    function sendAll(evts) {
        for (var i = 0; i < evts.length; ++i) {
            next(evts[i]);
        }
    }
    function process(evt, type) {
        var result = { type: type };
        var keyId = KeyboardUtil.getKey(evt);
        if (keyId) {
            result.keyId = keyId;
        }

        var keysym = KeyboardUtil.getKeysym(evt);

        var hasModifier = modifierState.hasShortcutModifier() || !!modifierState.activeCharModifier();
        // Is this a case where we have to decide on the keysym right away, rather than waiting for the keypress?
        // "special" keys like enter, tab or backspace don't send keypress events,
        // and some browsers don't send keypresses at all if a modifier is down
        if (keysym && (type !== 'keydown' || KeyboardUtil.nonCharacterKey(evt) || hasModifier)) {
            result.keysym = keysym;
        }

        var isShift = evt.keyCode === 0x10 || evt.key === 'Shift';

        // Should we prevent the browser from handling the event?
        // Doing so on a keydown (in most browsers) prevents keypress from being generated
        // so only do that if we have to.
        var suppress = !isShift && (type !== 'keydown' || modifierState.hasShortcutModifier() || !!KeyboardUtil.nonCharacterKey(evt));

        // If a char modifier is down on a keydown, we need to insert a stall,
        // so VerifyCharModifier knows to wait and see if a keypress is comnig
        var stall = type === 'keydown' && modifierState.activeCharModifier() && !KeyboardUtil.nonCharacterKey(evt);

        // if a char modifier is pressed, get the keys it consists of (on Windows, AltGr is equivalent to Ctrl+Alt)
        var active = modifierState.activeCharModifier();

        // If we have a char modifier down, and we're able to determine a keysym reliably
        // then (a) we know to treat the modifier as a char modifier,
        // and (b) we'll have to "escape" the modifier to undo the modifier when sending the char.
        if (active && keysym) {
            var isCharModifier = false;
            for (var i = 0; i < active.length; ++i) {
                if (active[i] === keysym.keysym) {
                    isCharModifier = true;
                }
            }
            if (type === 'keypress' && !isCharModifier) {
                result.escape = modifierState.activeCharModifier();
            }
        }

        if (stall) {
            // insert a fake "stall" event
            next({ type: 'stall' });
        }
        next(result);

        return suppress;
    }

    return {
        keydown: function (evt) {
            sendAll(modifierState.keydown(evt));
            return process(evt, 'keydown');
        },
        keypress: function (evt) {
            return process(evt, 'keypress');
        },
        keyup: function (evt) {
            sendAll(modifierState.keyup(evt));
            return process(evt, 'keyup');
        },
        syncModifiers: function (evt) {
            sendAll(modifierState.syncAny(evt));
        },
        releaseAll: function () {
            next({ type: 'releaseall' });
        }
    };
};

// Combines keydown and keypress events where necessary to handle char modifiers.
// On some OS'es, a char modifier is sometimes used as a shortcut modifier.
// For example, on Windows, AltGr is synonymous with Ctrl-Alt. On a Danish keyboard layout, AltGr-2 yields a @, but Ctrl-Alt-D does nothing
// so when used with the '2' key, Ctrl-Alt counts as a char modifier (and should be escaped), but when used with 'D', it does not.
// The only way we can distinguish these cases is to wait and see if a keypress event arrives
// When we receive a "stall" event, wait a few ms before processing the next keydown. If a keypress has also arrived, merge the two
KeyboardUtil.VerifyCharModifier = function (next) {
    "use strict";

    var queue = [];
    var timer = null;
    function process() {
        if (timer) {
            return;
        }

        var delayProcess = function () {
            clearTimeout(timer);
            timer = null;
            process();
        };

        while (queue.length !== 0) {
            var cur = queue[0];
            queue = queue.splice(1);
            switch (cur.type) {
                case 'stall':
                    // insert a delay before processing available events.
                    /* jshint loopfunc: true */
                    timer = setTimeout(delayProcess, 5);
                    /* jshint loopfunc: false */
                    return;
                case 'keydown':
                    // is the next element a keypress? Then we should merge the two
                    if (queue.length !== 0 && queue[0].type === 'keypress') {
                        // Firefox sends keypress even when no char is generated.
                        // so, if keypress keysym is the same as we'd have guessed from keydown,
                        // the modifier didn't have any effect, and should not be escaped
                        if (queue[0].escape && (!cur.keysym || cur.keysym.keysym !== queue[0].keysym.keysym)) {
                            cur.escape = queue[0].escape;
                        }
                        cur.keysym = queue[0].keysym;
                        queue = queue.splice(1);
                    }
                    break;
            }

            // swallow stall events, and pass all others to the next stage
            if (cur.type !== 'stall') {
                next(cur);
            }
        }
    }
    return function (evt) {
        queue.push(evt);
        process();
    };
};

// Keeps track of which keys we (and the server) believe are down
// When a keyup is received, match it against this list, to determine the corresponding keysym(s)
// in some cases, a single key may produce multiple keysyms, so the corresponding keyup event must release all of these chars
// key repeat events should be merged into a single entry.
// Because we can't always identify which entry a keydown or keyup event corresponds to, we sometimes have to guess
KeyboardUtil.TrackKeyState = function (next) {
    "use strict";

    var state = [];

    return function (evt) {
        var last = state.length !== 0 ? state[state.length - 1] : null;

        switch (evt.type) {
            case 'keydown':
                // insert a new entry if last seen key was different.
                if (!last || !evt.keyId || last.keyId !== evt.keyId) {
                    last = { keyId: evt.keyId, keysyms: {} };
                    state.push(last);
                }
                if (evt.keysym) {
                    // make sure last event contains this keysym (a single "logical" keyevent
                    // can cause multiple key events to be sent to the VNC server)
                    last.keysyms[evt.keysym.keysym] = evt.keysym;
                    last.ignoreKeyPress = true;
                    next(evt);
                }
                break;
            case 'keypress':
                if (!last) {
                    last = { keyId: evt.keyId, keysyms: {} };
                    state.push(last);
                }
                if (!evt.keysym) {
                    console.log('keypress with no keysym:', evt);
                }

                // If we didn't expect a keypress, and already sent a keydown to the VNC server
                // based on the keydown, make sure to skip this event.
                if (evt.keysym && !last.ignoreKeyPress) {
                    last.keysyms[evt.keysym.keysym] = evt.keysym;
                    evt.type = 'keydown';
                    next(evt);
                }
                break;
            case 'keyup':
                if (state.length === 0) {
                    return;
                }
                var idx = null;
                // do we have a matching key tracked as being down?
                for (var i = 0; i !== state.length; ++i) {
                    if (state[i].keyId === evt.keyId) {
                        idx = i;
                        break;
                    }
                }
                // if we couldn't find a match (it happens), assume it was the last key pressed
                if (idx === null) {
                    idx = state.length - 1;
                }

                var item = state.splice(idx, 1)[0];
                // for each keysym tracked by this key entry, clone the current event and override the keysym
                var clone = function () {
                    function Clone() {}
                    return function (obj) {
                        Clone.prototype = obj;return new Clone();
                    };
                }();
                for (var key in item.keysyms) {
                    var out = clone(evt);
                    out.keysym = item.keysyms[key];
                    next(out);
                }
                break;
            case 'releaseall':
                /* jshint shadow: true */
                for (var i = 0; i < state.length; ++i) {
                    for (var key in state[i].keysyms) {
                        var keysym = state[i].keysyms[key];
                        next({ keyId: 0, keysym: keysym, type: 'keyup' });
                    }
                }
                /* jshint shadow: false */
                state = [];
        }
    };
};

// Handles "escaping" of modifiers: if a char modifier is used to produce a keysym (such as AltGr-2 to generate an @),
// then the modifier must be "undone" before sending the @, and "redone" afterwards.
KeyboardUtil.EscapeModifiers = function (next) {
    "use strict";

    return function (evt) {
        if (evt.type !== 'keydown' || evt.escape === undefined) {
            next(evt);
            return;
        }
        // undo modifiers
        for (var i = 0; i < evt.escape.length; ++i) {
            next({ type: 'keyup', keyId: 0, keysym: _keysymdef2.default.lookup(evt.escape[i]) });
        }
        // send the character event
        next(evt);
        // redo modifiers
        /* jshint shadow: true */
        for (var i = 0; i < evt.escape.length; ++i) {
            next({ type: 'keydown', keyId: 0, keysym: _keysymdef2.default.lookup(evt.escape[i]) });
        }
        /* jshint shadow: false */
    };
};

exports.default = KeyboardUtil;
module.exports = exports["default"];
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInV0aWwuanMiXSwibmFtZXMiOlsiS2V5Ym9hcmRVdGlsIiwic3Vic3RpdHV0ZUNvZGVwb2ludCIsImNwIiwic3Vic3RpdHV0aW9ucyIsInN1YiIsImlzTWFjIiwibmF2aWdhdG9yIiwiZXhlYyIsInBsYXRmb3JtIiwiaXNXaW5kb3dzIiwiaXNMaW51eCIsImhhc1Nob3J0Y3V0TW9kaWZpZXIiLCJjaGFyTW9kaWZpZXIiLCJjdXJyZW50TW9kaWZpZXJzIiwibW9kcyIsImtleSIsInBhcnNlSW50IiwiWEtfU2hpZnRfTCIsInN1bSIsImsiLCJoYXNDaGFyTW9kaWZpZXIiLCJsZW5ndGgiLCJpIiwiTW9kaWZpZXJTeW5jIiwiWEtfQWx0X0wiLCJYS19Db250cm9sX0wiLCJYS19JU09fTGV2ZWwzX1NoaWZ0Iiwic3RhdGUiLCJYS19NZXRhX0wiLCJzeW5jIiwiZXZ0Iiwia2V5c3ltIiwicmVzdWx0Iiwic3luY0tleSIsImxvb2t1cCIsInR5cGUiLCJjdHJsS2V5IiwidW5kZWZpbmVkIiwicHVzaCIsImFsdEtleSIsImFsdEdyYXBoS2V5Iiwic2hpZnRLZXkiLCJtZXRhS2V5Iiwic3luY0tleUV2ZW50IiwiZG93biIsIm9iaiIsImdldEtleXN5bSIsImtleWRvd24iLCJrZXl1cCIsInN5bmNBbnkiLCJhY3RpdmVDaGFyTW9kaWZpZXIiLCJnZXRLZXkiLCJrZXlDb2RlIiwiY29kZXBvaW50IiwiY2hhciIsImNoYXJDb2RlQXQiLCJjaGFyQ29kZSIsInJlcyIsImZyb21Vbmljb2RlIiwia2V5c3ltRnJvbUtleUNvZGUiLCJ3aGljaCIsImtleWNvZGUiLCJzaGlmdFByZXNzZWQiLCJYS19LUF8wIiwiWEtfc3BhY2UiLCJYS19LUF9NdWx0aXBseSIsIlhLX0tQX0FkZCIsIlhLX0tQX1NlcGFyYXRvciIsIlhLX0tQX1N1YnRyYWN0IiwiWEtfS1BfRGVjaW1hbCIsIlhLX0tQX0RpdmlkZSIsIlhLX3BsdXMiLCJYS19jb21tYSIsIlhLX21pbnVzIiwiWEtfcGVyaW9kIiwibm9uQ2hhcmFjdGVyS2V5IiwiWEtfRjEiLCJYS19CYWNrU3BhY2UiLCJYS19SZXR1cm4iLCJYS19UYWIiLCJYS19Fc2NhcGUiLCJYS19EZWxldGUiLCJYS19Ib21lIiwiWEtfRW5kIiwiWEtfUGFnZV9VcCIsIlhLX1BhZ2VfRG93biIsIlhLX0luc2VydCIsIlhLX0xlZnQiLCJYS19VcCIsIlhLX1JpZ2h0IiwiWEtfRG93biIsIlhLX1N1cGVyX0wiLCJYS19TdXBlcl9SIiwiWEtfTWVudSIsIlFFTVVLZXlFdmVudERlY29kZXIiLCJtb2RpZmllclN0YXRlIiwibmV4dCIsInNlbmRBbGwiLCJldnRzIiwibnVtUGFkQ29kZXMiLCJudW1Mb2NrT25LZXlTeW1zIiwibnVtTG9ja09uS2V5Q29kZXMiLCJpc051bVBhZE11bHRpS2V5IiwiaW5kZXhPZiIsImNvZGUiLCJnZXROdW1QYWRLZXlTeW0iLCJwcm9jZXNzIiwiaGFzTW9kaWZpZXIiLCJpc1NoaWZ0Iiwic3VwcHJlc3MiLCJrZXlwcmVzcyIsInN5bmNNb2RpZmllcnMiLCJyZWxlYXNlQWxsIiwiVHJhY2tRRU1VS2V5U3RhdGUiLCJsYXN0IiwicG9wIiwiaWR4Iiwic3BsaWNlIiwiS2V5RXZlbnREZWNvZGVyIiwia2V5SWQiLCJzdGFsbCIsImFjdGl2ZSIsImlzQ2hhck1vZGlmaWVyIiwiZXNjYXBlIiwiVmVyaWZ5Q2hhck1vZGlmaWVyIiwicXVldWUiLCJ0aW1lciIsImRlbGF5UHJvY2VzcyIsImNsZWFyVGltZW91dCIsImN1ciIsInNldFRpbWVvdXQiLCJUcmFja0tleVN0YXRlIiwia2V5c3ltcyIsImlnbm9yZUtleVByZXNzIiwiY29uc29sZSIsImxvZyIsIml0ZW0iLCJjbG9uZSIsIkNsb25lIiwicHJvdG90eXBlIiwib3V0IiwiRXNjYXBlTW9kaWZpZXJzIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFBQTs7OztBQUNBOzs7Ozs7QUFHQSxJQUFJQSxlQUFlLEVBQW5COztBQUVBLENBQUMsWUFBVztBQUNSOztBQUVBLGFBQVNDLG1CQUFULENBQTZCQyxFQUE3QixFQUFpQztBQUM3QjtBQUNBO0FBQ0EsWUFBSUMsZ0JBQWdCO0FBQ2hCO0FBQ0EsbUJBQVEsS0FGUTtBQUdoQixtQkFBUSxLQUhRO0FBSWhCO0FBQ0EsbUJBQVEsS0FMUTtBQU1oQixtQkFBUTtBQU5RLFNBQXBCOztBQVNBLFlBQUlDLE1BQU1ELGNBQWNELEVBQWQsQ0FBVjtBQUNBLGVBQU9FLE1BQU1BLEdBQU4sR0FBWUYsRUFBbkI7QUFDSDs7QUFFRCxhQUFTRyxLQUFULEdBQWlCO0FBQ2IsZUFBT0MsYUFBYSxDQUFDLENBQUUsTUFBRCxDQUFTQyxJQUFULENBQWNELFVBQVVFLFFBQXhCLENBQXRCO0FBQ0g7QUFDRCxhQUFTQyxTQUFULEdBQXFCO0FBQ2pCLGVBQU9ILGFBQWEsQ0FBQyxDQUFFLE1BQUQsQ0FBU0MsSUFBVCxDQUFjRCxVQUFVRSxRQUF4QixDQUF0QjtBQUNIO0FBQ0QsYUFBU0UsT0FBVCxHQUFtQjtBQUNmLGVBQU9KLGFBQWEsQ0FBQyxDQUFFLFFBQUQsQ0FBV0MsSUFBWCxDQUFnQkQsVUFBVUUsUUFBMUIsQ0FBdEI7QUFDSDs7QUFFRDtBQUNBLGFBQVNHLG1CQUFULENBQTZCQyxZQUE3QixFQUEyQ0MsZ0JBQTNDLEVBQTZEO0FBQ3pELFlBQUlDLE9BQU8sRUFBWDtBQUNBLGFBQUssSUFBSUMsR0FBVCxJQUFnQkYsZ0JBQWhCLEVBQWtDO0FBQzlCLGdCQUFJRyxTQUFTRCxHQUFULE1BQWtCLGlCQUFTRSxVQUEvQixFQUEyQztBQUN2Q0gscUJBQUtDLEdBQUwsSUFBWUYsaUJBQWlCRSxHQUFqQixDQUFaO0FBQ0g7QUFDSjs7QUFFRCxZQUFJRyxNQUFNLENBQVY7QUFDQSxhQUFLLElBQUlDLENBQVQsSUFBY04sZ0JBQWQsRUFBZ0M7QUFDNUIsZ0JBQUlDLEtBQUtLLENBQUwsQ0FBSixFQUFhO0FBQ1Qsa0JBQUVELEdBQUY7QUFDSDtBQUNKO0FBQ0QsWUFBSUUsZ0JBQWdCUixZQUFoQixFQUE4QkUsSUFBOUIsQ0FBSixFQUF5QztBQUNyQyxtQkFBT0ksTUFBTU4sYUFBYVMsTUFBMUI7QUFDSCxTQUZELE1BR0s7QUFDRCxtQkFBT0gsTUFBTSxDQUFiO0FBQ0g7QUFDSjs7QUFFRDtBQUNBLGFBQVNFLGVBQVQsQ0FBeUJSLFlBQXpCLEVBQXVDQyxnQkFBdkMsRUFBeUQ7QUFDckQsWUFBSUQsYUFBYVMsTUFBYixLQUF3QixDQUE1QixFQUErQjtBQUFFLG1CQUFPLEtBQVA7QUFBZTs7QUFFaEQsYUFBSyxJQUFJQyxJQUFJLENBQWIsRUFBZ0JBLElBQUlWLGFBQWFTLE1BQWpDLEVBQXlDLEVBQUVDLENBQTNDLEVBQThDO0FBQzFDLGdCQUFJLENBQUNULGlCQUFpQkQsYUFBYVUsQ0FBYixDQUFqQixDQUFMLEVBQXdDO0FBQ3BDLHVCQUFPLEtBQVA7QUFDSDtBQUNKO0FBQ0QsZUFBTyxJQUFQO0FBQ0g7O0FBRUQ7QUFDQTtBQUNBLGFBQVNDLFlBQVQsQ0FBc0JYLFlBQXRCLEVBQW9DO0FBQ2hDLFlBQUksQ0FBQ0EsWUFBTCxFQUFtQjtBQUNmLGdCQUFJUCxPQUFKLEVBQWE7QUFDVDtBQUNBTywrQkFBZSxDQUFDLGlCQUFTWSxRQUFWLENBQWY7QUFDSCxhQUhELE1BSUssSUFBSWYsV0FBSixFQUFpQjtBQUNsQjtBQUNBRywrQkFBZSxDQUFDLGlCQUFTWSxRQUFWLEVBQW9CLGlCQUFTQyxZQUE3QixDQUFmO0FBQ0gsYUFISSxNQUlBLElBQUlmLFNBQUosRUFBZTtBQUNoQjtBQUNBRSwrQkFBZSxDQUFDLGlCQUFTYyxtQkFBVixDQUFmO0FBQ0gsYUFISSxNQUlBO0FBQ0RkLCtCQUFlLEVBQWY7QUFDSDtBQUNKOztBQUVELFlBQUllLFFBQVEsRUFBWjtBQUNBQSxjQUFNLGlCQUFTRixZQUFmLElBQStCLEtBQS9CO0FBQ0FFLGNBQU0saUJBQVNILFFBQWYsSUFBMkIsS0FBM0I7QUFDQUcsY0FBTSxpQkFBU0QsbUJBQWYsSUFBc0MsS0FBdEM7QUFDQUMsY0FBTSxpQkFBU1YsVUFBZixJQUE2QixLQUE3QjtBQUNBVSxjQUFNLGlCQUFTQyxTQUFmLElBQTRCLEtBQTVCOztBQUVBLGlCQUFTQyxJQUFULENBQWNDLEdBQWQsRUFBbUJDLE1BQW5CLEVBQTJCO0FBQ3ZCLGdCQUFJQyxTQUFTLEVBQWI7QUFDQSxxQkFBU0MsT0FBVCxDQUFpQkYsTUFBakIsRUFBeUI7QUFDckIsdUJBQU8sRUFBQ0EsUUFBUSxvQkFBUUcsTUFBUixDQUFlSCxNQUFmLENBQVQsRUFBaUNJLE1BQU1SLE1BQU1JLE1BQU4sSUFBZ0IsU0FBaEIsR0FBNEIsT0FBbkUsRUFBUDtBQUNIOztBQUVELGdCQUFJRCxJQUFJTSxPQUFKLEtBQWdCQyxTQUFoQixJQUNBUCxJQUFJTSxPQUFKLEtBQWdCVCxNQUFNLGlCQUFTRixZQUFmLENBRGhCLElBQ2dETSxXQUFXLGlCQUFTTixZQUR4RSxFQUNzRjtBQUNsRkUsc0JBQU0saUJBQVNGLFlBQWYsSUFBK0JLLElBQUlNLE9BQW5DO0FBQ0FKLHVCQUFPTSxJQUFQLENBQVlMLFFBQVEsaUJBQVNSLFlBQWpCLENBQVo7QUFDSDtBQUNELGdCQUFJSyxJQUFJUyxNQUFKLEtBQWVGLFNBQWYsSUFDQVAsSUFBSVMsTUFBSixLQUFlWixNQUFNLGlCQUFTSCxRQUFmLENBRGYsSUFDMkNPLFdBQVcsaUJBQVNQLFFBRG5FLEVBQzZFO0FBQ3pFRyxzQkFBTSxpQkFBU0gsUUFBZixJQUEyQk0sSUFBSVMsTUFBL0I7QUFDQVAsdUJBQU9NLElBQVAsQ0FBWUwsUUFBUSxpQkFBU1QsUUFBakIsQ0FBWjtBQUNIO0FBQ0QsZ0JBQUlNLElBQUlVLFdBQUosS0FBb0JILFNBQXBCLElBQ0FQLElBQUlVLFdBQUosS0FBb0JiLE1BQU0saUJBQVNELG1CQUFmLENBRHBCLElBQzJESyxXQUFXLGlCQUFTTCxtQkFEbkYsRUFDd0c7QUFDcEdDLHNCQUFNLGlCQUFTRCxtQkFBZixJQUFzQ0ksSUFBSVUsV0FBMUM7QUFDQVIsdUJBQU9NLElBQVAsQ0FBWUwsUUFBUSxpQkFBU1AsbUJBQWpCLENBQVo7QUFDSDtBQUNELGdCQUFJSSxJQUFJVyxRQUFKLEtBQWlCSixTQUFqQixJQUNBUCxJQUFJVyxRQUFKLEtBQWlCZCxNQUFNLGlCQUFTVixVQUFmLENBRGpCLElBQytDYyxXQUFXLGlCQUFTZCxVQUR2RSxFQUNtRjtBQUMvRVUsc0JBQU0saUJBQVNWLFVBQWYsSUFBNkJhLElBQUlXLFFBQWpDO0FBQ0FULHVCQUFPTSxJQUFQLENBQVlMLFFBQVEsaUJBQVNoQixVQUFqQixDQUFaO0FBQ0g7QUFDRCxnQkFBSWEsSUFBSVksT0FBSixLQUFnQkwsU0FBaEIsSUFDQVAsSUFBSVksT0FBSixLQUFnQmYsTUFBTSxpQkFBU0MsU0FBZixDQURoQixJQUM2Q0csV0FBVyxpQkFBU0gsU0FEckUsRUFDZ0Y7QUFDNUVELHNCQUFNLGlCQUFTQyxTQUFmLElBQTRCRSxJQUFJWSxPQUFoQztBQUNBVix1QkFBT00sSUFBUCxDQUFZTCxRQUFRLGlCQUFTTCxTQUFqQixDQUFaO0FBQ0g7QUFDRCxtQkFBT0ksTUFBUDtBQUNIO0FBQ0QsaUJBQVNXLFlBQVQsQ0FBc0JiLEdBQXRCLEVBQTJCYyxJQUEzQixFQUFpQztBQUM3QixnQkFBSUMsTUFBTUMsVUFBVWhCLEdBQVYsQ0FBVjtBQUNBLGdCQUFJQyxTQUFTYyxNQUFNQSxJQUFJZCxNQUFWLEdBQW1CLElBQWhDOztBQUVBO0FBQ0EsZ0JBQUlBLFdBQVcsSUFBWCxJQUFtQkosTUFBTUksTUFBTixNQUFrQk0sU0FBekMsRUFBb0Q7QUFDaERWLHNCQUFNSSxNQUFOLElBQWdCYSxJQUFoQjtBQUNIO0FBQ0QsbUJBQU9mLEtBQUtDLEdBQUwsRUFBVUMsTUFBVixDQUFQO0FBQ0g7O0FBRUQsZUFBTztBQUNIO0FBQ0FnQixxQkFBUyxVQUFTakIsR0FBVCxFQUFjO0FBQUUsdUJBQU9hLGFBQWFiLEdBQWIsRUFBa0IsSUFBbEIsQ0FBUDtBQUFnQyxhQUZ0RDtBQUdIa0IsbUJBQU8sVUFBU2xCLEdBQVQsRUFBYztBQUFFLHVCQUFPYSxhQUFhYixHQUFiLEVBQWtCLEtBQWxCLENBQVA7QUFBaUMsYUFIckQ7QUFJSDtBQUNBbUIscUJBQVMsVUFBU25CLEdBQVQsRUFBYztBQUFFLHVCQUFPRCxLQUFLQyxHQUFMLENBQVA7QUFBa0IsYUFMeEM7O0FBT0g7QUFDQW5CLGlDQUFxQixZQUFXO0FBQUUsdUJBQU9BLG9CQUFvQkMsWUFBcEIsRUFBa0NlLEtBQWxDLENBQVA7QUFBa0QsYUFSakY7QUFTSDtBQUNBdUIsZ0NBQW9CLFlBQVc7QUFBRSx1QkFBTzlCLGdCQUFnQlIsWUFBaEIsRUFBOEJlLEtBQTlCLElBQXVDZixZQUF2QyxHQUFzRCxJQUE3RDtBQUFvRTtBQVZsRyxTQUFQO0FBWUg7O0FBRUQ7QUFDQTtBQUNBLGFBQVN1QyxNQUFULENBQWdCckIsR0FBaEIsRUFBb0I7QUFDaEIsWUFBSSxhQUFhQSxHQUFiLElBQW9CLFNBQVNBLEdBQWpDLEVBQXNDO0FBQ2xDLG1CQUFPQSxJQUFJZixHQUFKLEdBQVUsR0FBVixHQUFnQmUsSUFBSXNCLE9BQTNCO0FBQ0gsU0FGRCxNQUdLLElBQUksYUFBYXRCLEdBQWpCLEVBQXNCO0FBQ3ZCLG1CQUFPQSxJQUFJc0IsT0FBWDtBQUNILFNBRkksTUFHQTtBQUNELG1CQUFPdEIsSUFBSWYsR0FBWDtBQUNIO0FBQ0o7O0FBRUQ7QUFDQTtBQUNBLGFBQVMrQixTQUFULENBQW1CaEIsR0FBbkIsRUFBdUI7QUFDbkIsWUFBSXVCLFNBQUo7QUFDQSxZQUFJdkIsSUFBSXdCLElBQUosSUFBWXhCLElBQUl3QixJQUFKLENBQVNqQyxNQUFULEtBQW9CLENBQXBDLEVBQXVDO0FBQ25DZ0Msd0JBQVl2QixJQUFJd0IsSUFBSixDQUFTQyxVQUFULEVBQVo7QUFDSCxTQUZELE1BR0ssSUFBSXpCLElBQUkwQixRQUFSLEVBQWtCO0FBQ25CSCx3QkFBWXZCLElBQUkwQixRQUFoQjtBQUNILFNBRkksTUFHQSxJQUFJMUIsSUFBSXNCLE9BQUosSUFBZXRCLElBQUlLLElBQUosS0FBYSxVQUFoQyxFQUE0QztBQUM3QztBQUNBa0Isd0JBQVl2QixJQUFJc0IsT0FBaEI7QUFDSDtBQUNELFlBQUlDLFNBQUosRUFBZTtBQUNYLGdCQUFJSSxNQUFNLG9CQUFRQyxXQUFSLENBQW9CekQsb0JBQW9Cb0QsU0FBcEIsQ0FBcEIsQ0FBVjtBQUNBLGdCQUFJSSxHQUFKLEVBQVM7QUFDTCx1QkFBT0EsR0FBUDtBQUNIO0FBQ0o7QUFDRDtBQUNBO0FBQ0E7QUFDQTtBQUNBLFlBQUkzQixJQUFJc0IsT0FBUixFQUFpQjtBQUNiLG1CQUFPLG9CQUFRbEIsTUFBUixDQUFleUIsa0JBQWtCN0IsSUFBSXNCLE9BQXRCLEVBQStCdEIsSUFBSVcsUUFBbkMsQ0FBZixDQUFQO0FBQ0g7QUFDRCxZQUFJWCxJQUFJOEIsS0FBUixFQUFlO0FBQ1gsbUJBQU8sb0JBQVExQixNQUFSLENBQWV5QixrQkFBa0I3QixJQUFJOEIsS0FBdEIsRUFBNkI5QixJQUFJVyxRQUFqQyxDQUFmLENBQVA7QUFDSDtBQUNELGVBQU8sSUFBUDtBQUNIOztBQUVEO0FBQ0E7QUFDQSxhQUFTa0IsaUJBQVQsQ0FBMkJFLE9BQTNCLEVBQW9DQyxZQUFwQyxFQUFrRDtBQUM5QyxZQUFJLE9BQU9ELE9BQVAsS0FBb0IsUUFBeEIsRUFBa0M7QUFDOUIsbUJBQU8sSUFBUDtBQUNIO0FBQ0Q7QUFDQSxZQUFJQSxXQUFXLElBQVgsSUFBbUJBLFdBQVcsSUFBbEMsRUFBd0M7QUFDcEMsbUJBQU9BLE9BQVAsQ0FEb0MsQ0FDcEI7QUFDbkI7QUFDRCxZQUFJQSxXQUFXLElBQVgsSUFBbUJBLFdBQVcsSUFBbEMsRUFBd0M7QUFDcEM7QUFDQSxtQkFBT0MsZUFBZUQsT0FBZixHQUF5QkEsVUFBVSxFQUExQyxDQUZvQyxDQUVVO0FBQ2pEO0FBQ0QsWUFBSUEsV0FBVyxJQUFYLElBQW1CQSxXQUFXLElBQWxDLEVBQXdDO0FBQ3BDLG1CQUFPLGlCQUFTRSxPQUFULElBQW9CRixVQUFVLElBQTlCLENBQVAsQ0FEb0MsQ0FDUTtBQUMvQzs7QUFFRCxnQkFBT0EsT0FBUDtBQUNJLGlCQUFLLElBQUw7QUFBVyx1QkFBTyxpQkFBU0csUUFBaEI7QUFDWCxpQkFBSyxJQUFMO0FBQVcsdUJBQU8saUJBQVNDLGNBQWhCO0FBQ1gsaUJBQUssSUFBTDtBQUFXLHVCQUFPLGlCQUFTQyxTQUFoQjtBQUNYLGlCQUFLLElBQUw7QUFBVyx1QkFBTyxpQkFBU0MsZUFBaEI7QUFDWCxpQkFBSyxJQUFMO0FBQVcsdUJBQU8saUJBQVNDLGNBQWhCO0FBQ1gsaUJBQUssSUFBTDtBQUFXLHVCQUFPLGlCQUFTQyxhQUFoQjtBQUNYLGlCQUFLLElBQUw7QUFBVyx1QkFBTyxpQkFBU0MsWUFBaEI7QUFDWCxpQkFBSyxJQUFMO0FBQVcsdUJBQU8saUJBQVNDLE9BQWhCO0FBQ1gsaUJBQUssSUFBTDtBQUFXLHVCQUFPLGlCQUFTQyxRQUFoQjtBQUNYLGlCQUFLLElBQUw7QUFBVyx1QkFBTyxpQkFBU0MsUUFBaEI7QUFDWCxpQkFBSyxJQUFMO0FBQVcsdUJBQU8saUJBQVNDLFNBQWhCO0FBWGY7O0FBY0EsZUFBT0MsZ0JBQWdCLEVBQUN2QixTQUFTUyxPQUFWLEVBQWhCLENBQVA7QUFDSDs7QUFFRDtBQUNBO0FBQ0EsYUFBU2MsZUFBVCxDQUF5QjdDLEdBQXpCLEVBQThCO0FBQzFCO0FBQ0EsWUFBSSxDQUFDQSxJQUFJc0IsT0FBVCxFQUFrQjtBQUFFLG1CQUFPLElBQVA7QUFBYztBQUNsQyxZQUFJUyxVQUFVL0IsSUFBSXNCLE9BQWxCOztBQUVBLFlBQUlTLFdBQVcsSUFBWCxJQUFtQkEsV0FBVyxJQUFsQyxFQUF3QztBQUNwQyxtQkFBTyxpQkFBU2UsS0FBVCxHQUFpQmYsT0FBakIsR0FBMkIsSUFBbEMsQ0FEb0MsQ0FDSTtBQUMzQztBQUNELGdCQUFRQSxPQUFSOztBQUVJLGlCQUFLLENBQUw7QUFBUyx1QkFBTyxpQkFBU2dCLFlBQWhCO0FBQ1QsaUJBQUssRUFBTDtBQUFVLHVCQUFPLGlCQUFTQyxTQUFoQjs7QUFFVixpQkFBSyxDQUFMO0FBQVMsdUJBQU8saUJBQVNDLE1BQWhCOztBQUVULGlCQUFLLEVBQUw7QUFBVSx1QkFBTyxpQkFBU0MsU0FBaEI7QUFDVixpQkFBSyxFQUFMO0FBQVUsdUJBQU8saUJBQVNDLFNBQWhCOztBQUVWLGlCQUFLLEVBQUw7QUFBVSx1QkFBTyxpQkFBU0MsT0FBaEI7QUFDVixpQkFBSyxFQUFMO0FBQVUsdUJBQU8saUJBQVNDLE1BQWhCO0FBQ1YsaUJBQUssRUFBTDtBQUFVLHVCQUFPLGlCQUFTQyxVQUFoQjtBQUNWLGlCQUFLLEVBQUw7QUFBVSx1QkFBTyxpQkFBU0MsWUFBaEI7QUFDVixpQkFBSyxFQUFMO0FBQVUsdUJBQU8saUJBQVNDLFNBQWhCOztBQUVWLGlCQUFLLEVBQUw7QUFBVSx1QkFBTyxpQkFBU0MsT0FBaEI7QUFDVixpQkFBSyxFQUFMO0FBQVUsdUJBQU8saUJBQVNDLEtBQWhCO0FBQ1YsaUJBQUssRUFBTDtBQUFVLHVCQUFPLGlCQUFTQyxRQUFoQjtBQUNWLGlCQUFLLEVBQUw7QUFBVSx1QkFBTyxpQkFBU0MsT0FBaEI7O0FBRVYsaUJBQUssRUFBTDtBQUFVLHVCQUFPLGlCQUFTekUsVUFBaEI7QUFDVixpQkFBSyxFQUFMO0FBQVUsdUJBQU8saUJBQVNRLFlBQWhCO0FBQ1YsaUJBQUssRUFBTDtBQUFVLHVCQUFPLGlCQUFTRCxRQUFoQixDQXZCZCxDQXVCd0M7O0FBRXBDLGlCQUFLLEdBQUw7QUFBVyx1QkFBTyxpQkFBU0ksU0FBaEI7QUFDWCxpQkFBSyxHQUFMO0FBQVcsdUJBQU8saUJBQVNGLG1CQUFoQixDQTFCZixDQTBCb0Q7QUFDaEQsaUJBQUssRUFBTDtBQUFVLHVCQUFPLGlCQUFTaUUsVUFBaEIsQ0EzQmQsQ0EyQjBDO0FBQ3RDLGlCQUFLLEVBQUw7QUFBVSx1QkFBTyxpQkFBU0MsVUFBaEIsQ0E1QmQsQ0E0QjBDO0FBQ3RDLGlCQUFLLEVBQUw7QUFBVSx1QkFBTyxpQkFBU0MsT0FBaEIsQ0E3QmQsQ0E2QnVDO0FBQ25DO0FBQVMsdUJBQU8sSUFBUDtBQTlCYjtBQWdDSDs7QUFFRDdGLGlCQUFhVyxtQkFBYixHQUFtQ0EsbUJBQW5DO0FBQ0FYLGlCQUFhb0IsZUFBYixHQUErQkEsZUFBL0I7QUFDQXBCLGlCQUFhdUIsWUFBYixHQUE0QkEsWUFBNUI7QUFDQXZCLGlCQUFhbUQsTUFBYixHQUFzQkEsTUFBdEI7QUFDQW5ELGlCQUFhOEMsU0FBYixHQUF5QkEsU0FBekI7QUFDQTlDLGlCQUFhMkQsaUJBQWIsR0FBaUNBLGlCQUFqQztBQUNBM0QsaUJBQWEyRSxlQUFiLEdBQStCQSxlQUEvQjtBQUNBM0UsaUJBQWFDLG1CQUFiLEdBQW1DQSxtQkFBbkM7QUFDSCxDQTVSRDs7QUE4UkFELGFBQWE4RixtQkFBYixHQUFtQyxVQUFTQyxhQUFULEVBQXdCQyxJQUF4QixFQUE4QjtBQUM3RDs7QUFFQSxhQUFTQyxPQUFULENBQWlCQyxJQUFqQixFQUF1QjtBQUNuQixhQUFLLElBQUk1RSxJQUFJLENBQWIsRUFBZ0JBLElBQUk0RSxLQUFLN0UsTUFBekIsRUFBaUMsRUFBRUMsQ0FBbkMsRUFBc0M7QUFDbEMwRSxpQkFBS0UsS0FBSzVFLENBQUwsQ0FBTDtBQUNIO0FBQ0o7O0FBRUQsUUFBSTZFLGNBQWMsQ0FBQyxTQUFELEVBQVksU0FBWixFQUF1QixTQUF2QixFQUNkLFNBRGMsRUFDSCxTQURHLEVBQ1EsU0FEUixFQUNtQixTQURuQixFQUVkLFNBRmMsRUFFSCxTQUZHLEVBRVEsU0FGUixFQUVtQixlQUZuQixDQUFsQjs7QUFJQSxRQUFJQyxtQkFBbUI7QUFDbkIsbUJBQVcsTUFEUSxFQUNBLFdBQVcsTUFEWCxFQUNtQixXQUFXLE1BRDlCO0FBRW5CLG1CQUFXLE1BRlEsRUFFQSxXQUFXLE1BRlgsRUFFbUIsV0FBVyxNQUY5QjtBQUduQixtQkFBVyxNQUhRLEVBR0EsV0FBVyxNQUhYLEVBR21CLFdBQVcsTUFIOUI7QUFJbkIsbUJBQVcsTUFKUSxFQUlBLGlCQUFpQjtBQUpqQixLQUF2Qjs7QUFPQSxRQUFJQyxvQkFBb0IsQ0FBQyxFQUFELEVBQUssRUFBTCxFQUFTLEVBQVQsRUFBYSxFQUFiLEVBQWlCLEdBQWpCLEVBQXNCLEdBQXRCLEVBQTJCLEdBQTNCLEVBQ3BCLEdBRG9CLEVBQ2YsR0FEZSxFQUNWLEdBRFUsRUFDTCxHQURLLEVBQ0EsR0FEQSxDQUF4Qjs7QUFHQSxhQUFTQyxnQkFBVCxDQUEwQnhFLEdBQTFCLEVBQStCO0FBQzNCLGVBQVFxRSxZQUFZSSxPQUFaLENBQW9CekUsSUFBSTBFLElBQXhCLE1BQWtDLENBQUMsQ0FBM0M7QUFDSDs7QUFFRCxhQUFTQyxlQUFULENBQXlCM0UsR0FBekIsRUFBOEI7QUFDMUIsWUFBSXVFLGtCQUFrQkUsT0FBbEIsQ0FBMEJ6RSxJQUFJc0IsT0FBOUIsTUFBMkMsQ0FBQyxDQUFoRCxFQUFtRDtBQUMvQyxtQkFBT2dELGlCQUFpQnRFLElBQUkwRSxJQUFyQixDQUFQO0FBQ0g7QUFDRCxlQUFPLENBQVA7QUFDSDs7QUFFRCxhQUFTRSxPQUFULENBQWlCNUUsR0FBakIsRUFBc0JLLElBQXRCLEVBQTRCO0FBQ3hCLFlBQUlILFNBQVMsRUFBQ0csTUFBTUEsSUFBUCxFQUFiO0FBQ0FILGVBQU93RSxJQUFQLEdBQWMxRSxJQUFJMEUsSUFBbEI7QUFDQXhFLGVBQU9ELE1BQVAsR0FBZ0IsQ0FBaEI7O0FBRUEsWUFBSXVFLGlCQUFpQnhFLEdBQWpCLENBQUosRUFBMkI7QUFDdkJFLG1CQUFPRCxNQUFQLEdBQWdCMEUsZ0JBQWdCM0UsR0FBaEIsQ0FBaEI7QUFDSDs7QUFFRCxZQUFJNkUsY0FBY1osY0FBY3BGLG1CQUFkLE1BQXVDLENBQUMsQ0FBQ29GLGNBQWM3QyxrQkFBZCxFQUEzRDtBQUNBLFlBQUkwRCxVQUFVOUUsSUFBSXNCLE9BQUosS0FBZ0IsSUFBaEIsSUFBd0J0QixJQUFJZixHQUFKLEtBQVksT0FBbEQ7O0FBRUEsWUFBSThGLFdBQVcsQ0FBQ0QsT0FBRCxLQUFhekUsU0FBUyxTQUFULElBQXNCNEQsY0FBY3BGLG1CQUFkLEVBQXRCLElBQTZELENBQUMsQ0FBQ1gsYUFBYTJFLGVBQWIsQ0FBNkI3QyxHQUE3QixDQUE1RSxDQUFmOztBQUVBa0UsYUFBS2hFLE1BQUw7QUFDQSxlQUFPNkUsUUFBUDtBQUNIO0FBQ0QsV0FBTztBQUNIOUQsaUJBQVMsVUFBU2pCLEdBQVQsRUFBYztBQUNuQm1FLG9CQUFRRixjQUFjaEQsT0FBZCxDQUFzQmpCLEdBQXRCLENBQVI7QUFDQSxtQkFBTzRFLFFBQVE1RSxHQUFSLEVBQWEsU0FBYixDQUFQO0FBQ0gsU0FKRTtBQUtIZ0Ysa0JBQVUsVUFBU2hGLEdBQVQsRUFBYztBQUNwQixtQkFBTyxJQUFQO0FBQ0gsU0FQRTtBQVFIa0IsZUFBTyxVQUFTbEIsR0FBVCxFQUFjO0FBQ2pCbUUsb0JBQVFGLGNBQWMvQyxLQUFkLENBQW9CbEIsR0FBcEIsQ0FBUjtBQUNBLG1CQUFPNEUsUUFBUTVFLEdBQVIsRUFBYSxPQUFiLENBQVA7QUFDSCxTQVhFO0FBWUhpRix1QkFBZSxVQUFTakYsR0FBVCxFQUFjO0FBQ3pCbUUsb0JBQVFGLGNBQWM5QyxPQUFkLENBQXNCbkIsR0FBdEIsQ0FBUjtBQUNILFNBZEU7QUFlSGtGLG9CQUFZLFlBQVc7QUFBRWhCLGlCQUFLLEVBQUM3RCxNQUFNLFlBQVAsRUFBTDtBQUE2QjtBQWZuRCxLQUFQO0FBaUJILENBcEVEOztBQXNFQW5DLGFBQWFpSCxpQkFBYixHQUFpQyxVQUFTakIsSUFBVCxFQUFlO0FBQzVDOztBQUNBLFFBQUlyRSxRQUFRLEVBQVo7O0FBRUEsV0FBTyxVQUFVRyxHQUFWLEVBQWU7QUFDbEIsWUFBSW9GLE9BQU92RixNQUFNTixNQUFOLEtBQWlCLENBQWpCLEdBQXFCTSxNQUFNQSxNQUFNTixNQUFOLEdBQWEsQ0FBbkIsQ0FBckIsR0FBNkMsSUFBeEQ7O0FBRUEsZ0JBQVFTLElBQUlLLElBQVo7QUFDQSxpQkFBSyxTQUFMOztBQUVJLG9CQUFJLENBQUMrRSxJQUFELElBQVNBLEtBQUtWLElBQUwsS0FBYzFFLElBQUkwRSxJQUEvQixFQUFxQztBQUNqQ1UsMkJBQU8sRUFBQ1YsTUFBTTFFLElBQUkwRSxJQUFYLEVBQVA7O0FBRUEsd0JBQUk3RSxNQUFNTixNQUFOLEdBQWUsQ0FBZixJQUFvQk0sTUFBTUEsTUFBTU4sTUFBTixHQUFhLENBQW5CLEVBQXNCbUYsSUFBdEIsSUFBOEIsYUFBdEQsRUFBcUU7QUFDaEUsNEJBQUkxRSxJQUFJMEUsSUFBSixLQUFhLFVBQWpCLEVBQTZCO0FBQ3pCUixpQ0FBSyxFQUFDUSxNQUFNLGFBQVAsRUFBc0JyRSxNQUFNLFNBQTVCLEVBQXVDSixRQUFRLENBQS9DLEVBQUw7QUFDSCx5QkFGRCxNQUVPO0FBQ0hKLGtDQUFNd0YsR0FBTjtBQUNIO0FBQ0w7QUFDRHhGLDBCQUFNVyxJQUFOLENBQVc0RSxJQUFYO0FBQ0g7QUFDRCxvQkFBSXBGLElBQUkwRSxJQUFKLEtBQWEsYUFBakIsRUFBZ0M7QUFDNUJSLHlCQUFLbEUsR0FBTDtBQUNIO0FBQ0Q7O0FBRUosaUJBQUssT0FBTDtBQUNJLG9CQUFJSCxNQUFNTixNQUFOLEtBQWlCLENBQXJCLEVBQXdCO0FBQ3BCO0FBQ0g7QUFDRCxvQkFBSStGLE1BQU0sSUFBVjtBQUNBO0FBQ0EscUJBQUssSUFBSTlGLElBQUksQ0FBYixFQUFnQkEsTUFBTUssTUFBTU4sTUFBNUIsRUFBb0MsRUFBRUMsQ0FBdEMsRUFBeUM7QUFDckMsd0JBQUlLLE1BQU1MLENBQU4sRUFBU2tGLElBQVQsS0FBa0IxRSxJQUFJMEUsSUFBMUIsRUFBZ0M7QUFDNUJZLDhCQUFNOUYsQ0FBTjtBQUNBO0FBQ0g7QUFDSjtBQUNEO0FBQ0Esb0JBQUk4RixRQUFRLElBQVosRUFBa0I7QUFDZCx3QkFBSXRGLElBQUkwRSxJQUFKLEtBQWEsYUFBakIsRUFBZ0M7QUFDNUI7QUFDSDtBQUNEWSwwQkFBTXpGLE1BQU1OLE1BQU4sR0FBZSxDQUFyQjtBQUNIOztBQUVETSxzQkFBTTBGLE1BQU4sQ0FBYUQsR0FBYixFQUFrQixDQUFsQjtBQUNBcEIscUJBQUtsRSxHQUFMO0FBQ0E7QUFDSixpQkFBSyxZQUFMO0FBQ0k7QUFDQSxxQkFBSyxJQUFJUixJQUFJLENBQWIsRUFBZ0JBLElBQUlLLE1BQU1OLE1BQTFCLEVBQWtDLEVBQUVDLENBQXBDLEVBQXVDO0FBQ25DMEUseUJBQUssRUFBQ1EsTUFBTTdFLE1BQU1MLENBQU4sRUFBU2tGLElBQWhCLEVBQXNCekUsUUFBUSxDQUE5QixFQUFpQ0ksTUFBTSxPQUF2QyxFQUFMO0FBQ0g7QUFDRDtBQUNBUix3QkFBUSxFQUFSO0FBakRKO0FBbURILEtBdEREO0FBdURILENBM0REOztBQTZEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBM0IsYUFBYXNILGVBQWIsR0FBK0IsVUFBU3ZCLGFBQVQsRUFBd0JDLElBQXhCLEVBQThCO0FBQ3pEOztBQUNBLGFBQVNDLE9BQVQsQ0FBaUJDLElBQWpCLEVBQXVCO0FBQ25CLGFBQUssSUFBSTVFLElBQUksQ0FBYixFQUFnQkEsSUFBSTRFLEtBQUs3RSxNQUF6QixFQUFpQyxFQUFFQyxDQUFuQyxFQUFzQztBQUNsQzBFLGlCQUFLRSxLQUFLNUUsQ0FBTCxDQUFMO0FBQ0g7QUFDSjtBQUNELGFBQVNvRixPQUFULENBQWlCNUUsR0FBakIsRUFBc0JLLElBQXRCLEVBQTRCO0FBQ3hCLFlBQUlILFNBQVMsRUFBQ0csTUFBTUEsSUFBUCxFQUFiO0FBQ0EsWUFBSW9GLFFBQVF2SCxhQUFhbUQsTUFBYixDQUFvQnJCLEdBQXBCLENBQVo7QUFDQSxZQUFJeUYsS0FBSixFQUFXO0FBQ1B2RixtQkFBT3VGLEtBQVAsR0FBZUEsS0FBZjtBQUNIOztBQUVELFlBQUl4RixTQUFTL0IsYUFBYThDLFNBQWIsQ0FBdUJoQixHQUF2QixDQUFiOztBQUVBLFlBQUk2RSxjQUFjWixjQUFjcEYsbUJBQWQsTUFBdUMsQ0FBQyxDQUFDb0YsY0FBYzdDLGtCQUFkLEVBQTNEO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsWUFBSW5CLFdBQVdJLFNBQVMsU0FBVCxJQUFzQm5DLGFBQWEyRSxlQUFiLENBQTZCN0MsR0FBN0IsQ0FBdEIsSUFBMkQ2RSxXQUF0RSxDQUFKLEVBQXdGO0FBQ3BGM0UsbUJBQU9ELE1BQVAsR0FBZ0JBLE1BQWhCO0FBQ0g7O0FBRUQsWUFBSTZFLFVBQVU5RSxJQUFJc0IsT0FBSixLQUFnQixJQUFoQixJQUF3QnRCLElBQUlmLEdBQUosS0FBWSxPQUFsRDs7QUFFQTtBQUNBO0FBQ0E7QUFDQSxZQUFJOEYsV0FBVyxDQUFDRCxPQUFELEtBQWF6RSxTQUFTLFNBQVQsSUFBc0I0RCxjQUFjcEYsbUJBQWQsRUFBdEIsSUFBNkQsQ0FBQyxDQUFDWCxhQUFhMkUsZUFBYixDQUE2QjdDLEdBQTdCLENBQTVFLENBQWY7O0FBRUE7QUFDQTtBQUNBLFlBQUkwRixRQUFRckYsU0FBUyxTQUFULElBQXNCNEQsY0FBYzdDLGtCQUFkLEVBQXRCLElBQTRELENBQUNsRCxhQUFhMkUsZUFBYixDQUE2QjdDLEdBQTdCLENBQXpFOztBQUVBO0FBQ0EsWUFBSTJGLFNBQVMxQixjQUFjN0Msa0JBQWQsRUFBYjs7QUFFQTtBQUNBO0FBQ0E7QUFDQSxZQUFJdUUsVUFBVTFGLE1BQWQsRUFBc0I7QUFDbEIsZ0JBQUkyRixpQkFBaUIsS0FBckI7QUFDQSxpQkFBSyxJQUFJcEcsSUFBSyxDQUFkLEVBQWlCQSxJQUFJbUcsT0FBT3BHLE1BQTVCLEVBQW9DLEVBQUVDLENBQXRDLEVBQXlDO0FBQ3JDLG9CQUFJbUcsT0FBT25HLENBQVAsTUFBY1MsT0FBT0EsTUFBekIsRUFBaUM7QUFDN0IyRixxQ0FBaUIsSUFBakI7QUFDSDtBQUNKO0FBQ0QsZ0JBQUl2RixTQUFTLFVBQVQsSUFBdUIsQ0FBQ3VGLGNBQTVCLEVBQTRDO0FBQ3hDMUYsdUJBQU8yRixNQUFQLEdBQWdCNUIsY0FBYzdDLGtCQUFkLEVBQWhCO0FBQ0g7QUFDSjs7QUFFRCxZQUFJc0UsS0FBSixFQUFXO0FBQ1A7QUFDQXhCLGlCQUFLLEVBQUM3RCxNQUFNLE9BQVAsRUFBTDtBQUNIO0FBQ0Q2RCxhQUFLaEUsTUFBTDs7QUFFQSxlQUFPNkUsUUFBUDtBQUNIOztBQUVELFdBQU87QUFDSDlELGlCQUFTLFVBQVNqQixHQUFULEVBQWM7QUFDbkJtRSxvQkFBUUYsY0FBY2hELE9BQWQsQ0FBc0JqQixHQUF0QixDQUFSO0FBQ0EsbUJBQU80RSxRQUFRNUUsR0FBUixFQUFhLFNBQWIsQ0FBUDtBQUNILFNBSkU7QUFLSGdGLGtCQUFVLFVBQVNoRixHQUFULEVBQWM7QUFDcEIsbUJBQU80RSxRQUFRNUUsR0FBUixFQUFhLFVBQWIsQ0FBUDtBQUNILFNBUEU7QUFRSGtCLGVBQU8sVUFBU2xCLEdBQVQsRUFBYztBQUNqQm1FLG9CQUFRRixjQUFjL0MsS0FBZCxDQUFvQmxCLEdBQXBCLENBQVI7QUFDQSxtQkFBTzRFLFFBQVE1RSxHQUFSLEVBQWEsT0FBYixDQUFQO0FBQ0gsU0FYRTtBQVlIaUYsdUJBQWUsVUFBU2pGLEdBQVQsRUFBYztBQUN6Qm1FLG9CQUFRRixjQUFjOUMsT0FBZCxDQUFzQm5CLEdBQXRCLENBQVI7QUFDSCxTQWRFO0FBZUhrRixvQkFBWSxZQUFXO0FBQUVoQixpQkFBSyxFQUFDN0QsTUFBTSxZQUFQLEVBQUw7QUFBNkI7QUFmbkQsS0FBUDtBQWlCSCxDQS9FRDs7QUFpRkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0FuQyxhQUFhNEgsa0JBQWIsR0FBa0MsVUFBUzVCLElBQVQsRUFBZTtBQUM3Qzs7QUFDQSxRQUFJNkIsUUFBUSxFQUFaO0FBQ0EsUUFBSUMsUUFBUSxJQUFaO0FBQ0EsYUFBU3BCLE9BQVQsR0FBbUI7QUFDZixZQUFJb0IsS0FBSixFQUFXO0FBQ1A7QUFDSDs7QUFFRCxZQUFJQyxlQUFlLFlBQVk7QUFDM0JDLHlCQUFhRixLQUFiO0FBQ0FBLG9CQUFRLElBQVI7QUFDQXBCO0FBQ0gsU0FKRDs7QUFNQSxlQUFPbUIsTUFBTXhHLE1BQU4sS0FBaUIsQ0FBeEIsRUFBMkI7QUFDdkIsZ0JBQUk0RyxNQUFNSixNQUFNLENBQU4sQ0FBVjtBQUNBQSxvQkFBUUEsTUFBTVIsTUFBTixDQUFhLENBQWIsQ0FBUjtBQUNBLG9CQUFRWSxJQUFJOUYsSUFBWjtBQUNBLHFCQUFLLE9BQUw7QUFDSTtBQUNBO0FBQ0EyRiw0QkFBUUksV0FBV0gsWUFBWCxFQUF5QixDQUF6QixDQUFSO0FBQ0E7QUFDQTtBQUNKLHFCQUFLLFNBQUw7QUFDSTtBQUNBLHdCQUFJRixNQUFNeEcsTUFBTixLQUFpQixDQUFqQixJQUFzQndHLE1BQU0sQ0FBTixFQUFTMUYsSUFBVCxLQUFrQixVQUE1QyxFQUF3RDtBQUNwRDtBQUNBO0FBQ0E7QUFDQSw0QkFBSTBGLE1BQU0sQ0FBTixFQUFTRixNQUFULEtBQW9CLENBQUNNLElBQUlsRyxNQUFMLElBQWVrRyxJQUFJbEcsTUFBSixDQUFXQSxNQUFYLEtBQXNCOEYsTUFBTSxDQUFOLEVBQVM5RixNQUFULENBQWdCQSxNQUF6RSxDQUFKLEVBQXNGO0FBQ2xGa0csZ0NBQUlOLE1BQUosR0FBYUUsTUFBTSxDQUFOLEVBQVNGLE1BQXRCO0FBQ0g7QUFDRE0sNEJBQUlsRyxNQUFKLEdBQWE4RixNQUFNLENBQU4sRUFBUzlGLE1BQXRCO0FBQ0E4RixnQ0FBUUEsTUFBTVIsTUFBTixDQUFhLENBQWIsQ0FBUjtBQUNIO0FBQ0Q7QUFuQko7O0FBc0JBO0FBQ0EsZ0JBQUlZLElBQUk5RixJQUFKLEtBQWEsT0FBakIsRUFBMEI7QUFDdEI2RCxxQkFBS2lDLEdBQUw7QUFDSDtBQUNKO0FBQ0o7QUFDRCxXQUFPLFVBQVNuRyxHQUFULEVBQWM7QUFDakIrRixjQUFNdkYsSUFBTixDQUFXUixHQUFYO0FBQ0E0RTtBQUNILEtBSEQ7QUFJSCxDQWxERDs7QUFvREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBMUcsYUFBYW1JLGFBQWIsR0FBNkIsVUFBU25DLElBQVQsRUFBZTtBQUN4Qzs7QUFDQSxRQUFJckUsUUFBUSxFQUFaOztBQUVBLFdBQU8sVUFBVUcsR0FBVixFQUFlO0FBQ2xCLFlBQUlvRixPQUFPdkYsTUFBTU4sTUFBTixLQUFpQixDQUFqQixHQUFxQk0sTUFBTUEsTUFBTU4sTUFBTixHQUFhLENBQW5CLENBQXJCLEdBQTZDLElBQXhEOztBQUVBLGdCQUFRUyxJQUFJSyxJQUFaO0FBQ0EsaUJBQUssU0FBTDtBQUNJO0FBQ0Esb0JBQUksQ0FBQytFLElBQUQsSUFBUyxDQUFDcEYsSUFBSXlGLEtBQWQsSUFBdUJMLEtBQUtLLEtBQUwsS0FBZXpGLElBQUl5RixLQUE5QyxFQUFxRDtBQUNqREwsMkJBQU8sRUFBQ0ssT0FBT3pGLElBQUl5RixLQUFaLEVBQW1CYSxTQUFTLEVBQTVCLEVBQVA7QUFDQXpHLDBCQUFNVyxJQUFOLENBQVc0RSxJQUFYO0FBQ0g7QUFDRCxvQkFBSXBGLElBQUlDLE1BQVIsRUFBZ0I7QUFDWjtBQUNBO0FBQ0FtRix5QkFBS2tCLE9BQUwsQ0FBYXRHLElBQUlDLE1BQUosQ0FBV0EsTUFBeEIsSUFBa0NELElBQUlDLE1BQXRDO0FBQ0FtRix5QkFBS21CLGNBQUwsR0FBc0IsSUFBdEI7QUFDQXJDLHlCQUFLbEUsR0FBTDtBQUNIO0FBQ0Q7QUFDSixpQkFBSyxVQUFMO0FBQ0ksb0JBQUksQ0FBQ29GLElBQUwsRUFBVztBQUNQQSwyQkFBTyxFQUFDSyxPQUFPekYsSUFBSXlGLEtBQVosRUFBbUJhLFNBQVMsRUFBNUIsRUFBUDtBQUNBekcsMEJBQU1XLElBQU4sQ0FBVzRFLElBQVg7QUFDSDtBQUNELG9CQUFJLENBQUNwRixJQUFJQyxNQUFULEVBQWlCO0FBQ2J1Ryw0QkFBUUMsR0FBUixDQUFZLDBCQUFaLEVBQXdDekcsR0FBeEM7QUFDSDs7QUFFRDtBQUNBO0FBQ0Esb0JBQUlBLElBQUlDLE1BQUosSUFBYyxDQUFDbUYsS0FBS21CLGNBQXhCLEVBQXdDO0FBQ3BDbkIseUJBQUtrQixPQUFMLENBQWF0RyxJQUFJQyxNQUFKLENBQVdBLE1BQXhCLElBQWtDRCxJQUFJQyxNQUF0QztBQUNBRCx3QkFBSUssSUFBSixHQUFXLFNBQVg7QUFDQTZELHlCQUFLbEUsR0FBTDtBQUNIO0FBQ0Q7QUFDSixpQkFBSyxPQUFMO0FBQ0ksb0JBQUlILE1BQU1OLE1BQU4sS0FBaUIsQ0FBckIsRUFBd0I7QUFDcEI7QUFDSDtBQUNELG9CQUFJK0YsTUFBTSxJQUFWO0FBQ0E7QUFDQSxxQkFBSyxJQUFJOUYsSUFBSSxDQUFiLEVBQWdCQSxNQUFNSyxNQUFNTixNQUE1QixFQUFvQyxFQUFFQyxDQUF0QyxFQUF5QztBQUNyQyx3QkFBSUssTUFBTUwsQ0FBTixFQUFTaUcsS0FBVCxLQUFtQnpGLElBQUl5RixLQUEzQixFQUFrQztBQUM5QkgsOEJBQU05RixDQUFOO0FBQ0E7QUFDSDtBQUNKO0FBQ0Q7QUFDQSxvQkFBSThGLFFBQVEsSUFBWixFQUFrQjtBQUNkQSwwQkFBTXpGLE1BQU1OLE1BQU4sR0FBZSxDQUFyQjtBQUNIOztBQUVELG9CQUFJbUgsT0FBTzdHLE1BQU0wRixNQUFOLENBQWFELEdBQWIsRUFBa0IsQ0FBbEIsRUFBcUIsQ0FBckIsQ0FBWDtBQUNBO0FBQ0Esb0JBQUlxQixRQUFTLFlBQVU7QUFDbkIsNkJBQVNDLEtBQVQsR0FBZ0IsQ0FBRTtBQUNsQiwyQkFBTyxVQUFVN0YsR0FBVixFQUFlO0FBQUU2Riw4QkFBTUMsU0FBTixHQUFnQjlGLEdBQWhCLENBQXFCLE9BQU8sSUFBSTZGLEtBQUosRUFBUDtBQUFxQixxQkFBbEU7QUFDSCxpQkFIWSxFQUFiO0FBSUEscUJBQUssSUFBSTNILEdBQVQsSUFBZ0J5SCxLQUFLSixPQUFyQixFQUE4QjtBQUMxQix3QkFBSVEsTUFBTUgsTUFBTTNHLEdBQU4sQ0FBVjtBQUNBOEcsd0JBQUk3RyxNQUFKLEdBQWF5RyxLQUFLSixPQUFMLENBQWFySCxHQUFiLENBQWI7QUFDQWlGLHlCQUFLNEMsR0FBTDtBQUNIO0FBQ0Q7QUFDSixpQkFBSyxZQUFMO0FBQ0k7QUFDQSxxQkFBSyxJQUFJdEgsSUFBSSxDQUFiLEVBQWdCQSxJQUFJSyxNQUFNTixNQUExQixFQUFrQyxFQUFFQyxDQUFwQyxFQUF1QztBQUNuQyx5QkFBSyxJQUFJUCxHQUFULElBQWdCWSxNQUFNTCxDQUFOLEVBQVM4RyxPQUF6QixFQUFrQztBQUM5Qiw0QkFBSXJHLFNBQVNKLE1BQU1MLENBQU4sRUFBUzhHLE9BQVQsQ0FBaUJySCxHQUFqQixDQUFiO0FBQ0FpRiw2QkFBSyxFQUFDdUIsT0FBTyxDQUFSLEVBQVd4RixRQUFRQSxNQUFuQixFQUEyQkksTUFBTSxPQUFqQyxFQUFMO0FBQ0g7QUFDSjtBQUNEO0FBQ0FSLHdCQUFRLEVBQVI7QUF0RUo7QUF3RUgsS0EzRUQ7QUE0RUgsQ0FoRkQ7O0FBa0ZBO0FBQ0E7QUFDQTNCLGFBQWE2SSxlQUFiLEdBQStCLFVBQVM3QyxJQUFULEVBQWU7QUFDMUM7O0FBQ0EsV0FBTyxVQUFTbEUsR0FBVCxFQUFjO0FBQ2pCLFlBQUlBLElBQUlLLElBQUosS0FBYSxTQUFiLElBQTBCTCxJQUFJNkYsTUFBSixLQUFldEYsU0FBN0MsRUFBd0Q7QUFDcEQyRCxpQkFBS2xFLEdBQUw7QUFDQTtBQUNIO0FBQ0Q7QUFDQSxhQUFLLElBQUlSLElBQUksQ0FBYixFQUFnQkEsSUFBSVEsSUFBSTZGLE1BQUosQ0FBV3RHLE1BQS9CLEVBQXVDLEVBQUVDLENBQXpDLEVBQTRDO0FBQ3hDMEUsaUJBQUssRUFBQzdELE1BQU0sT0FBUCxFQUFnQm9GLE9BQU8sQ0FBdkIsRUFBMEJ4RixRQUFRLG9CQUFRRyxNQUFSLENBQWVKLElBQUk2RixNQUFKLENBQVdyRyxDQUFYLENBQWYsQ0FBbEMsRUFBTDtBQUNIO0FBQ0Q7QUFDQTBFLGFBQUtsRSxHQUFMO0FBQ0E7QUFDQTtBQUNBLGFBQUssSUFBSVIsSUFBSSxDQUFiLEVBQWdCQSxJQUFJUSxJQUFJNkYsTUFBSixDQUFXdEcsTUFBL0IsRUFBdUMsRUFBRUMsQ0FBekMsRUFBNEM7QUFDeEMwRSxpQkFBSyxFQUFDN0QsTUFBTSxTQUFQLEVBQWtCb0YsT0FBTyxDQUF6QixFQUE0QnhGLFFBQVEsb0JBQVFHLE1BQVIsQ0FBZUosSUFBSTZGLE1BQUosQ0FBV3JHLENBQVgsQ0FBZixDQUFwQyxFQUFMO0FBQ0g7QUFDRDtBQUNILEtBakJEO0FBa0JILENBcEJEOztrQkFzQmV0QixZIiwiZmlsZSI6InV0aWwuanMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgS2V5VGFibGUgZnJvbSBcIi4va2V5c3ltXCI7XG5pbXBvcnQga2V5c3ltcyBmcm9tIFwiLi9rZXlzeW1kZWZcIjtcblxuXG52YXIgS2V5Ym9hcmRVdGlsID0ge307XG5cbihmdW5jdGlvbigpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcblxuICAgIGZ1bmN0aW9uIHN1YnN0aXR1dGVDb2RlcG9pbnQoY3ApIHtcbiAgICAgICAgLy8gQW55IFVuaWNvZGUgY29kZSBwb2ludHMgd2hpY2ggZG8gbm90IGhhdmUgY29ycmVzcG9uZGluZyBrZXlzeW0gZW50cmllc1xuICAgICAgICAvLyBjYW4gYmUgc3dhcHBlZCBvdXQgZm9yIGFub3RoZXIgY29kZSBwb2ludCBieSBhZGRpbmcgdGhlbSB0byB0aGlzIHRhYmxlXG4gICAgICAgIHZhciBzdWJzdGl0dXRpb25zID0ge1xuICAgICAgICAgICAgLy8ge1Msc30gd2l0aCBjb21tYSBiZWxvdyAtPiB7UyxzfSB3aXRoIGNlZGlsbGFcbiAgICAgICAgICAgIDB4MjE4IDogMHgxNWUsXG4gICAgICAgICAgICAweDIxOSA6IDB4MTVmLFxuICAgICAgICAgICAgLy8ge1QsdH0gd2l0aCBjb21tYSBiZWxvdyAtPiB7VCx0fSB3aXRoIGNlZGlsbGFcbiAgICAgICAgICAgIDB4MjFhIDogMHgxNjIsXG4gICAgICAgICAgICAweDIxYiA6IDB4MTYzXG4gICAgICAgIH07XG5cbiAgICAgICAgdmFyIHN1YiA9IHN1YnN0aXR1dGlvbnNbY3BdO1xuICAgICAgICByZXR1cm4gc3ViID8gc3ViIDogY3A7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gaXNNYWMoKSB7XG4gICAgICAgIHJldHVybiBuYXZpZ2F0b3IgJiYgISEoL21hYy9pKS5leGVjKG5hdmlnYXRvci5wbGF0Zm9ybSk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIGlzV2luZG93cygpIHtcbiAgICAgICAgcmV0dXJuIG5hdmlnYXRvciAmJiAhISgvd2luL2kpLmV4ZWMobmF2aWdhdG9yLnBsYXRmb3JtKTtcbiAgICB9XG4gICAgZnVuY3Rpb24gaXNMaW51eCgpIHtcbiAgICAgICAgcmV0dXJuIG5hdmlnYXRvciAmJiAhISgvbGludXgvaSkuZXhlYyhuYXZpZ2F0b3IucGxhdGZvcm0pO1xuICAgIH1cblxuICAgIC8vIFJldHVybiB0cnVlIGlmIGEgbW9kaWZpZXIgd2hpY2ggaXMgbm90IHRoZSBzcGVjaWZpZWQgY2hhciBtb2RpZmllciAoYW5kIGlzIG5vdCBzaGlmdCkgaXMgZG93blxuICAgIGZ1bmN0aW9uIGhhc1Nob3J0Y3V0TW9kaWZpZXIoY2hhck1vZGlmaWVyLCBjdXJyZW50TW9kaWZpZXJzKSB7XG4gICAgICAgIHZhciBtb2RzID0ge307XG4gICAgICAgIGZvciAodmFyIGtleSBpbiBjdXJyZW50TW9kaWZpZXJzKSB7XG4gICAgICAgICAgICBpZiAocGFyc2VJbnQoa2V5KSAhPT0gS2V5VGFibGUuWEtfU2hpZnRfTCkge1xuICAgICAgICAgICAgICAgIG1vZHNba2V5XSA9IGN1cnJlbnRNb2RpZmllcnNba2V5XTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBzdW0gPSAwO1xuICAgICAgICBmb3IgKHZhciBrIGluIGN1cnJlbnRNb2RpZmllcnMpIHtcbiAgICAgICAgICAgIGlmIChtb2RzW2tdKSB7XG4gICAgICAgICAgICAgICAgKytzdW07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGhhc0NoYXJNb2RpZmllcihjaGFyTW9kaWZpZXIsIG1vZHMpKSB7XG4gICAgICAgICAgICByZXR1cm4gc3VtID4gY2hhck1vZGlmaWVyLmxlbmd0aDtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIHJldHVybiBzdW0gPiAwO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gUmV0dXJuIHRydWUgaWYgdGhlIHNwZWNpZmllZCBjaGFyIG1vZGlmaWVyIGlzIGN1cnJlbnRseSBkb3duXG4gICAgZnVuY3Rpb24gaGFzQ2hhck1vZGlmaWVyKGNoYXJNb2RpZmllciwgY3VycmVudE1vZGlmaWVycykge1xuICAgICAgICBpZiAoY2hhck1vZGlmaWVyLmxlbmd0aCA9PT0gMCkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGNoYXJNb2RpZmllci5sZW5ndGg7ICsraSkge1xuICAgICAgICAgICAgaWYgKCFjdXJyZW50TW9kaWZpZXJzW2NoYXJNb2RpZmllcltpXV0pIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLy8gSGVscGVyIG9iamVjdCB0cmFja2luZyBtb2RpZmllciBrZXkgc3RhdGVcbiAgICAvLyBhbmQgZ2VuZXJhdGVzIGZha2Uga2V5IGV2ZW50cyB0byBjb21wZW5zYXRlIGlmIGl0IGdldHMgb3V0IG9mIHN5bmNcbiAgICBmdW5jdGlvbiBNb2RpZmllclN5bmMoY2hhck1vZGlmaWVyKSB7XG4gICAgICAgIGlmICghY2hhck1vZGlmaWVyKSB7XG4gICAgICAgICAgICBpZiAoaXNNYWMoKSkge1xuICAgICAgICAgICAgICAgIC8vIG9uIE1hYywgT3B0aW9uIChBS0EgQWx0KSBpcyB1c2VkIGFzIGEgY2hhciBtb2RpZmllclxuICAgICAgICAgICAgICAgIGNoYXJNb2RpZmllciA9IFtLZXlUYWJsZS5YS19BbHRfTF07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBlbHNlIGlmIChpc1dpbmRvd3MoKSkge1xuICAgICAgICAgICAgICAgIC8vIG9uIFdpbmRvd3MsIEN0cmwrQWx0IGlzIHVzZWQgYXMgYSBjaGFyIG1vZGlmaWVyXG4gICAgICAgICAgICAgICAgY2hhck1vZGlmaWVyID0gW0tleVRhYmxlLlhLX0FsdF9MLCBLZXlUYWJsZS5YS19Db250cm9sX0xdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZWxzZSBpZiAoaXNMaW51eCgpKSB7XG4gICAgICAgICAgICAgICAgLy8gb24gTGludXgsIElTTyBMZXZlbCAzIFNoaWZ0IChBbHRHcikgaXMgdXNlZCBhcyBhIGNoYXIgbW9kaWZpZXJcbiAgICAgICAgICAgICAgICBjaGFyTW9kaWZpZXIgPSBbS2V5VGFibGUuWEtfSVNPX0xldmVsM19TaGlmdF07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgICAgICBjaGFyTW9kaWZpZXIgPSBbXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBzdGF0ZSA9IHt9O1xuICAgICAgICBzdGF0ZVtLZXlUYWJsZS5YS19Db250cm9sX0xdID0gZmFsc2U7XG4gICAgICAgIHN0YXRlW0tleVRhYmxlLlhLX0FsdF9MXSA9IGZhbHNlO1xuICAgICAgICBzdGF0ZVtLZXlUYWJsZS5YS19JU09fTGV2ZWwzX1NoaWZ0XSA9IGZhbHNlO1xuICAgICAgICBzdGF0ZVtLZXlUYWJsZS5YS19TaGlmdF9MXSA9IGZhbHNlO1xuICAgICAgICBzdGF0ZVtLZXlUYWJsZS5YS19NZXRhX0xdID0gZmFsc2U7XG5cbiAgICAgICAgZnVuY3Rpb24gc3luYyhldnQsIGtleXN5bSkge1xuICAgICAgICAgICAgdmFyIHJlc3VsdCA9IFtdO1xuICAgICAgICAgICAgZnVuY3Rpb24gc3luY0tleShrZXlzeW0pIHtcbiAgICAgICAgICAgICAgICByZXR1cm4ge2tleXN5bToga2V5c3ltcy5sb29rdXAoa2V5c3ltKSwgdHlwZTogc3RhdGVba2V5c3ltXSA/ICdrZXlkb3duJyA6ICdrZXl1cCd9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZXZ0LmN0cmxLZXkgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgICAgICAgICAgIGV2dC5jdHJsS2V5ICE9PSBzdGF0ZVtLZXlUYWJsZS5YS19Db250cm9sX0xdICYmIGtleXN5bSAhPT0gS2V5VGFibGUuWEtfQ29udHJvbF9MKSB7XG4gICAgICAgICAgICAgICAgc3RhdGVbS2V5VGFibGUuWEtfQ29udHJvbF9MXSA9IGV2dC5jdHJsS2V5O1xuICAgICAgICAgICAgICAgIHJlc3VsdC5wdXNoKHN5bmNLZXkoS2V5VGFibGUuWEtfQ29udHJvbF9MKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoZXZ0LmFsdEtleSAhPT0gdW5kZWZpbmVkICYmXG4gICAgICAgICAgICAgICAgZXZ0LmFsdEtleSAhPT0gc3RhdGVbS2V5VGFibGUuWEtfQWx0X0xdICYmIGtleXN5bSAhPT0gS2V5VGFibGUuWEtfQWx0X0wpIHtcbiAgICAgICAgICAgICAgICBzdGF0ZVtLZXlUYWJsZS5YS19BbHRfTF0gPSBldnQuYWx0S2V5O1xuICAgICAgICAgICAgICAgIHJlc3VsdC5wdXNoKHN5bmNLZXkoS2V5VGFibGUuWEtfQWx0X0wpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChldnQuYWx0R3JhcGhLZXkgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgICAgICAgICAgIGV2dC5hbHRHcmFwaEtleSAhPT0gc3RhdGVbS2V5VGFibGUuWEtfSVNPX0xldmVsM19TaGlmdF0gJiYga2V5c3ltICE9PSBLZXlUYWJsZS5YS19JU09fTGV2ZWwzX1NoaWZ0KSB7XG4gICAgICAgICAgICAgICAgc3RhdGVbS2V5VGFibGUuWEtfSVNPX0xldmVsM19TaGlmdF0gPSBldnQuYWx0R3JhcGhLZXk7XG4gICAgICAgICAgICAgICAgcmVzdWx0LnB1c2goc3luY0tleShLZXlUYWJsZS5YS19JU09fTGV2ZWwzX1NoaWZ0KSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoZXZ0LnNoaWZ0S2V5ICE9PSB1bmRlZmluZWQgJiZcbiAgICAgICAgICAgICAgICBldnQuc2hpZnRLZXkgIT09IHN0YXRlW0tleVRhYmxlLlhLX1NoaWZ0X0xdICYmIGtleXN5bSAhPT0gS2V5VGFibGUuWEtfU2hpZnRfTCkge1xuICAgICAgICAgICAgICAgIHN0YXRlW0tleVRhYmxlLlhLX1NoaWZ0X0xdID0gZXZ0LnNoaWZ0S2V5O1xuICAgICAgICAgICAgICAgIHJlc3VsdC5wdXNoKHN5bmNLZXkoS2V5VGFibGUuWEtfU2hpZnRfTCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGV2dC5tZXRhS2V5ICE9PSB1bmRlZmluZWQgJiZcbiAgICAgICAgICAgICAgICBldnQubWV0YUtleSAhPT0gc3RhdGVbS2V5VGFibGUuWEtfTWV0YV9MXSAmJiBrZXlzeW0gIT09IEtleVRhYmxlLlhLX01ldGFfTCkge1xuICAgICAgICAgICAgICAgIHN0YXRlW0tleVRhYmxlLlhLX01ldGFfTF0gPSBldnQubWV0YUtleTtcbiAgICAgICAgICAgICAgICByZXN1bHQucHVzaChzeW5jS2V5KEtleVRhYmxlLlhLX01ldGFfTCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfVxuICAgICAgICBmdW5jdGlvbiBzeW5jS2V5RXZlbnQoZXZ0LCBkb3duKSB7XG4gICAgICAgICAgICB2YXIgb2JqID0gZ2V0S2V5c3ltKGV2dCk7XG4gICAgICAgICAgICB2YXIga2V5c3ltID0gb2JqID8gb2JqLmtleXN5bSA6IG51bGw7XG5cbiAgICAgICAgICAgIC8vIGZpcnN0LCBhcHBseSB0aGUgZXZlbnQgaXRzZWxmLCBpZiByZWxldmFudFxuICAgICAgICAgICAgaWYgKGtleXN5bSAhPT0gbnVsbCAmJiBzdGF0ZVtrZXlzeW1dICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgICBzdGF0ZVtrZXlzeW1dID0gZG93bjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBzeW5jKGV2dCwga2V5c3ltKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAvLyBzeW5jIG9uIHRoZSBhcHByb3ByaWF0ZSBrZXlib2FyZCBldmVudFxuICAgICAgICAgICAga2V5ZG93bjogZnVuY3Rpb24oZXZ0KSB7IHJldHVybiBzeW5jS2V5RXZlbnQoZXZ0LCB0cnVlKTt9LFxuICAgICAgICAgICAga2V5dXA6IGZ1bmN0aW9uKGV2dCkgeyByZXR1cm4gc3luY0tleUV2ZW50KGV2dCwgZmFsc2UpO30sXG4gICAgICAgICAgICAvLyBDYWxsIHRoaXMgd2l0aCBhIG5vbi1rZXlib2FyZCBldmVudCAoc3VjaCBhcyBtb3VzZSBldmVudHMpIHRvIHVzZSBpdHMgbW9kaWZpZXIgc3RhdGUgdG8gc3luY2hyb25pemUgYW55d2F5XG4gICAgICAgICAgICBzeW5jQW55OiBmdW5jdGlvbihldnQpIHsgcmV0dXJuIHN5bmMoZXZ0KTt9LFxuXG4gICAgICAgICAgICAvLyBpcyBhIHNob3J0Y3V0IG1vZGlmaWVyIGRvd24/XG4gICAgICAgICAgICBoYXNTaG9ydGN1dE1vZGlmaWVyOiBmdW5jdGlvbigpIHsgcmV0dXJuIGhhc1Nob3J0Y3V0TW9kaWZpZXIoY2hhck1vZGlmaWVyLCBzdGF0ZSk7IH0sXG4gICAgICAgICAgICAvLyBpZiBhIGNoYXIgbW9kaWZpZXIgaXMgZG93biwgcmV0dXJuIHRoZSBrZXlzIGl0IGNvbnNpc3RzIG9mLCBvdGhlcndpc2UgcmV0dXJuIG51bGxcbiAgICAgICAgICAgIGFjdGl2ZUNoYXJNb2RpZmllcjogZnVuY3Rpb24oKSB7IHJldHVybiBoYXNDaGFyTW9kaWZpZXIoY2hhck1vZGlmaWVyLCBzdGF0ZSkgPyBjaGFyTW9kaWZpZXIgOiBudWxsOyB9XG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gR2V0IGEga2V5IElEIGZyb20gYSBrZXlib2FyZCBldmVudFxuICAgIC8vIE1heSBiZSBhIHN0cmluZyBvciBhbiBpbnRlZ2VyIGRlcGVuZGluZyBvbiB0aGUgYXZhaWxhYmxlIHByb3BlcnRpZXNcbiAgICBmdW5jdGlvbiBnZXRLZXkoZXZ0KXtcbiAgICAgICAgaWYgKCdrZXlDb2RlJyBpbiBldnQgJiYgJ2tleScgaW4gZXZ0KSB7XG4gICAgICAgICAgICByZXR1cm4gZXZ0LmtleSArICc6JyArIGV2dC5rZXlDb2RlO1xuICAgICAgICB9XG4gICAgICAgIGVsc2UgaWYgKCdrZXlDb2RlJyBpbiBldnQpIHtcbiAgICAgICAgICAgIHJldHVybiBldnQua2V5Q29kZTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIHJldHVybiBldnQua2V5O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gR2V0IHRoZSBtb3N0IHJlbGlhYmxlIGtleXN5bSB2YWx1ZSB3ZSBjYW4gZ2V0IGZyb20gYSBrZXkgZXZlbnRcbiAgICAvLyBpZiBjaGFyL2NoYXJDb2RlIGlzIGF2YWlsYWJsZSwgcHJlZmVyIHRob3NlLCBvdGhlcndpc2UgZmFsbCBiYWNrIHRvIGtleS9rZXlDb2RlL3doaWNoXG4gICAgZnVuY3Rpb24gZ2V0S2V5c3ltKGV2dCl7XG4gICAgICAgIHZhciBjb2RlcG9pbnQ7XG4gICAgICAgIGlmIChldnQuY2hhciAmJiBldnQuY2hhci5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgICAgIGNvZGVwb2ludCA9IGV2dC5jaGFyLmNoYXJDb2RlQXQoKTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIGlmIChldnQuY2hhckNvZGUpIHtcbiAgICAgICAgICAgIGNvZGVwb2ludCA9IGV2dC5jaGFyQ29kZTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIGlmIChldnQua2V5Q29kZSAmJiBldnQudHlwZSA9PT0gJ2tleXByZXNzJykge1xuICAgICAgICAgICAgLy8gSUUxMCBzdG9yZXMgdGhlIGNoYXIgY29kZSBhcyBrZXlDb2RlLCBhbmQgaGFzIG5vIG90aGVyIHVzZWZ1bCBwcm9wZXJ0aWVzXG4gICAgICAgICAgICBjb2RlcG9pbnQgPSBldnQua2V5Q29kZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY29kZXBvaW50KSB7XG4gICAgICAgICAgICB2YXIgcmVzID0ga2V5c3ltcy5mcm9tVW5pY29kZShzdWJzdGl0dXRlQ29kZXBvaW50KGNvZGVwb2ludCkpO1xuICAgICAgICAgICAgaWYgKHJlcykge1xuICAgICAgICAgICAgICAgIHJldHVybiByZXM7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgLy8gd2UgY291bGQgY2hlY2sgZXZ0LmtleSBoZXJlLlxuICAgICAgICAvLyBMZWdhbCB2YWx1ZXMgYXJlIGRlZmluZWQgaW4gaHR0cDovL3d3dy53My5vcmcvVFIvRE9NLUxldmVsLTMtRXZlbnRzLyNrZXktdmFsdWVzLWxpc3QsXG4gICAgICAgIC8vIHNvIHdlIFwianVzdFwiIG5lZWQgdG8gbWFwIHRoZW0gdG8ga2V5c3ltLCBidXQgQUZBSUsgdGhpcyBpcyBvbmx5IGF2YWlsYWJsZSBpbiBJRTEwLCB3aGljaCBhbHNvIHByb3ZpZGVzIGV2dC5rZXlcbiAgICAgICAgLy8gc28gd2UgZG9uJ3QgKm5lZWQqIGl0IHlldFxuICAgICAgICBpZiAoZXZ0LmtleUNvZGUpIHtcbiAgICAgICAgICAgIHJldHVybiBrZXlzeW1zLmxvb2t1cChrZXlzeW1Gcm9tS2V5Q29kZShldnQua2V5Q29kZSwgZXZ0LnNoaWZ0S2V5KSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGV2dC53aGljaCkge1xuICAgICAgICAgICAgcmV0dXJuIGtleXN5bXMubG9va3VwKGtleXN5bUZyb21LZXlDb2RlKGV2dC53aGljaCwgZXZ0LnNoaWZ0S2V5KSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgLy8gR2l2ZW4gYSBrZXljb2RlLCB0cnkgdG8gcHJlZGljdCB3aGljaCBrZXlzeW0gaXQgbWlnaHQgYmUuXG4gICAgLy8gSWYgdGhlIGtleWNvZGUgaXMgdW5rbm93biwgbnVsbCBpcyByZXR1cm5lZC5cbiAgICBmdW5jdGlvbiBrZXlzeW1Gcm9tS2V5Q29kZShrZXljb2RlLCBzaGlmdFByZXNzZWQpIHtcbiAgICAgICAgaWYgKHR5cGVvZihrZXljb2RlKSAhPT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG4gICAgICAgIC8vIHdvbid0IGJlIGFjY3VyYXRlIGZvciBhemVydHlcbiAgICAgICAgaWYgKGtleWNvZGUgPj0gMHgzMCAmJiBrZXljb2RlIDw9IDB4MzkpIHtcbiAgICAgICAgICAgIHJldHVybiBrZXljb2RlOyAvLyBkaWdpdFxuICAgICAgICB9XG4gICAgICAgIGlmIChrZXljb2RlID49IDB4NDEgJiYga2V5Y29kZSA8PSAweDVhKSB7XG4gICAgICAgICAgICAvLyByZW1hcCB0byBsb3dlcmNhc2UgdW5sZXNzIHNoaWZ0IGlzIGRvd25cbiAgICAgICAgICAgIHJldHVybiBzaGlmdFByZXNzZWQgPyBrZXljb2RlIDoga2V5Y29kZSArIDMyOyAvLyBBLVpcbiAgICAgICAgfVxuICAgICAgICBpZiAoa2V5Y29kZSA+PSAweDYwICYmIGtleWNvZGUgPD0gMHg2OSkge1xuICAgICAgICAgICAgcmV0dXJuIEtleVRhYmxlLlhLX0tQXzAgKyAoa2V5Y29kZSAtIDB4NjApOyAvLyBudW1wYWQgMC05XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2goa2V5Y29kZSkge1xuICAgICAgICAgICAgY2FzZSAweDIwOiByZXR1cm4gS2V5VGFibGUuWEtfc3BhY2U7XG4gICAgICAgICAgICBjYXNlIDB4NmE6IHJldHVybiBLZXlUYWJsZS5YS19LUF9NdWx0aXBseTtcbiAgICAgICAgICAgIGNhc2UgMHg2YjogcmV0dXJuIEtleVRhYmxlLlhLX0tQX0FkZDtcbiAgICAgICAgICAgIGNhc2UgMHg2YzogcmV0dXJuIEtleVRhYmxlLlhLX0tQX1NlcGFyYXRvcjtcbiAgICAgICAgICAgIGNhc2UgMHg2ZDogcmV0dXJuIEtleVRhYmxlLlhLX0tQX1N1YnRyYWN0O1xuICAgICAgICAgICAgY2FzZSAweDZlOiByZXR1cm4gS2V5VGFibGUuWEtfS1BfRGVjaW1hbDtcbiAgICAgICAgICAgIGNhc2UgMHg2ZjogcmV0dXJuIEtleVRhYmxlLlhLX0tQX0RpdmlkZTtcbiAgICAgICAgICAgIGNhc2UgMHhiYjogcmV0dXJuIEtleVRhYmxlLlhLX3BsdXM7XG4gICAgICAgICAgICBjYXNlIDB4YmM6IHJldHVybiBLZXlUYWJsZS5YS19jb21tYTtcbiAgICAgICAgICAgIGNhc2UgMHhiZDogcmV0dXJuIEtleVRhYmxlLlhLX21pbnVzO1xuICAgICAgICAgICAgY2FzZSAweGJlOiByZXR1cm4gS2V5VGFibGUuWEtfcGVyaW9kO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG5vbkNoYXJhY3RlcktleSh7a2V5Q29kZToga2V5Y29kZX0pO1xuICAgIH1cblxuICAgIC8vIGlmIHRoZSBrZXkgaXMgYSBrbm93biBub24tY2hhcmFjdGVyIGtleSAoYW55IGtleSB3aGljaCBkb2Vzbid0IGdlbmVyYXRlIGNoYXJhY3RlciBkYXRhKVxuICAgIC8vIHJldHVybiBpdHMga2V5c3ltIHZhbHVlLiBPdGhlcndpc2UgcmV0dXJuIG51bGxcbiAgICBmdW5jdGlvbiBub25DaGFyYWN0ZXJLZXkoZXZ0KSB7XG4gICAgICAgIC8vIGV2dC5rZXkgbm90IGltcGxlbWVudGVkIHlldFxuICAgICAgICBpZiAoIWV2dC5rZXlDb2RlKSB7IHJldHVybiBudWxsOyB9XG4gICAgICAgIHZhciBrZXljb2RlID0gZXZ0LmtleUNvZGU7XG5cbiAgICAgICAgaWYgKGtleWNvZGUgPj0gMHg3MCAmJiBrZXljb2RlIDw9IDB4ODcpIHtcbiAgICAgICAgICAgIHJldHVybiBLZXlUYWJsZS5YS19GMSArIGtleWNvZGUgLSAweDcwOyAvLyBGMS1GMjRcbiAgICAgICAgfVxuICAgICAgICBzd2l0Y2ggKGtleWNvZGUpIHtcblxuICAgICAgICAgICAgY2FzZSA4IDogcmV0dXJuIEtleVRhYmxlLlhLX0JhY2tTcGFjZTtcbiAgICAgICAgICAgIGNhc2UgMTMgOiByZXR1cm4gS2V5VGFibGUuWEtfUmV0dXJuO1xuXG4gICAgICAgICAgICBjYXNlIDkgOiByZXR1cm4gS2V5VGFibGUuWEtfVGFiO1xuXG4gICAgICAgICAgICBjYXNlIDI3IDogcmV0dXJuIEtleVRhYmxlLlhLX0VzY2FwZTtcbiAgICAgICAgICAgIGNhc2UgNDYgOiByZXR1cm4gS2V5VGFibGUuWEtfRGVsZXRlO1xuXG4gICAgICAgICAgICBjYXNlIDM2IDogcmV0dXJuIEtleVRhYmxlLlhLX0hvbWU7XG4gICAgICAgICAgICBjYXNlIDM1IDogcmV0dXJuIEtleVRhYmxlLlhLX0VuZDtcbiAgICAgICAgICAgIGNhc2UgMzMgOiByZXR1cm4gS2V5VGFibGUuWEtfUGFnZV9VcDtcbiAgICAgICAgICAgIGNhc2UgMzQgOiByZXR1cm4gS2V5VGFibGUuWEtfUGFnZV9Eb3duO1xuICAgICAgICAgICAgY2FzZSA0NSA6IHJldHVybiBLZXlUYWJsZS5YS19JbnNlcnQ7XG5cbiAgICAgICAgICAgIGNhc2UgMzcgOiByZXR1cm4gS2V5VGFibGUuWEtfTGVmdDtcbiAgICAgICAgICAgIGNhc2UgMzggOiByZXR1cm4gS2V5VGFibGUuWEtfVXA7XG4gICAgICAgICAgICBjYXNlIDM5IDogcmV0dXJuIEtleVRhYmxlLlhLX1JpZ2h0O1xuICAgICAgICAgICAgY2FzZSA0MCA6IHJldHVybiBLZXlUYWJsZS5YS19Eb3duO1xuXG4gICAgICAgICAgICBjYXNlIDE2IDogcmV0dXJuIEtleVRhYmxlLlhLX1NoaWZ0X0w7XG4gICAgICAgICAgICBjYXNlIDE3IDogcmV0dXJuIEtleVRhYmxlLlhLX0NvbnRyb2xfTDtcbiAgICAgICAgICAgIGNhc2UgMTggOiByZXR1cm4gS2V5VGFibGUuWEtfQWx0X0w7IC8vIGFsc286IE9wdGlvbi1rZXkgb24gTWFjXG5cbiAgICAgICAgICAgIGNhc2UgMjI0IDogcmV0dXJuIEtleVRhYmxlLlhLX01ldGFfTDtcbiAgICAgICAgICAgIGNhc2UgMjI1IDogcmV0dXJuIEtleVRhYmxlLlhLX0lTT19MZXZlbDNfU2hpZnQ7IC8vIEFsdEdyXG4gICAgICAgICAgICBjYXNlIDkxIDogcmV0dXJuIEtleVRhYmxlLlhLX1N1cGVyX0w7IC8vIGFsc286IFdpbmRvd3Mta2V5XG4gICAgICAgICAgICBjYXNlIDkyIDogcmV0dXJuIEtleVRhYmxlLlhLX1N1cGVyX1I7IC8vIGFsc286IFdpbmRvd3Mta2V5XG4gICAgICAgICAgICBjYXNlIDkzIDogcmV0dXJuIEtleVRhYmxlLlhLX01lbnU7IC8vIGFsc286IFdpbmRvd3MtTWVudSwgQ29tbWFuZCBvbiBNYWNcbiAgICAgICAgICAgIGRlZmF1bHQ6IHJldHVybiBudWxsO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgS2V5Ym9hcmRVdGlsLmhhc1Nob3J0Y3V0TW9kaWZpZXIgPSBoYXNTaG9ydGN1dE1vZGlmaWVyO1xuICAgIEtleWJvYXJkVXRpbC5oYXNDaGFyTW9kaWZpZXIgPSBoYXNDaGFyTW9kaWZpZXI7XG4gICAgS2V5Ym9hcmRVdGlsLk1vZGlmaWVyU3luYyA9IE1vZGlmaWVyU3luYztcbiAgICBLZXlib2FyZFV0aWwuZ2V0S2V5ID0gZ2V0S2V5O1xuICAgIEtleWJvYXJkVXRpbC5nZXRLZXlzeW0gPSBnZXRLZXlzeW07XG4gICAgS2V5Ym9hcmRVdGlsLmtleXN5bUZyb21LZXlDb2RlID0ga2V5c3ltRnJvbUtleUNvZGU7XG4gICAgS2V5Ym9hcmRVdGlsLm5vbkNoYXJhY3RlcktleSA9IG5vbkNoYXJhY3RlcktleTtcbiAgICBLZXlib2FyZFV0aWwuc3Vic3RpdHV0ZUNvZGVwb2ludCA9IHN1YnN0aXR1dGVDb2RlcG9pbnQ7XG59KSgpO1xuXG5LZXlib2FyZFV0aWwuUUVNVUtleUV2ZW50RGVjb2RlciA9IGZ1bmN0aW9uKG1vZGlmaWVyU3RhdGUsIG5leHQpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcblxuICAgIGZ1bmN0aW9uIHNlbmRBbGwoZXZ0cykge1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGV2dHMubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgICAgIG5leHQoZXZ0c1tpXSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICB2YXIgbnVtUGFkQ29kZXMgPSBbXCJOdW1wYWQwXCIsIFwiTnVtcGFkMVwiLCBcIk51bXBhZDJcIixcbiAgICAgICAgXCJOdW1wYWQzXCIsIFwiTnVtcGFkNFwiLCBcIk51bXBhZDVcIiwgXCJOdW1wYWQ2XCIsXG4gICAgICAgIFwiTnVtcGFkN1wiLCBcIk51bXBhZDhcIiwgXCJOdW1wYWQ5XCIsIFwiTnVtcGFkRGVjaW1hbFwiXTtcblxuICAgIHZhciBudW1Mb2NrT25LZXlTeW1zID0ge1xuICAgICAgICBcIk51bXBhZDBcIjogMHhmZmIwLCBcIk51bXBhZDFcIjogMHhmZmIxLCBcIk51bXBhZDJcIjogMHhmZmIyLFxuICAgICAgICBcIk51bXBhZDNcIjogMHhmZmIzLCBcIk51bXBhZDRcIjogMHhmZmI0LCBcIk51bXBhZDVcIjogMHhmZmI1LFxuICAgICAgICBcIk51bXBhZDZcIjogMHhmZmI2LCBcIk51bXBhZDdcIjogMHhmZmI3LCBcIk51bXBhZDhcIjogMHhmZmI4LFxuICAgICAgICBcIk51bXBhZDlcIjogMHhmZmI5LCBcIk51bXBhZERlY2ltYWxcIjogMHhmZmFjXG4gICAgfTtcblxuICAgIHZhciBudW1Mb2NrT25LZXlDb2RlcyA9IFs5NiwgOTcsIDk4LCA5OSwgMTAwLCAxMDEsIDEwMixcbiAgICAgICAgMTAzLCAxMDQsIDEwNSwgMTA4LCAxMTBdO1xuXG4gICAgZnVuY3Rpb24gaXNOdW1QYWRNdWx0aUtleShldnQpIHtcbiAgICAgICAgcmV0dXJuIChudW1QYWRDb2Rlcy5pbmRleE9mKGV2dC5jb2RlKSAhPT0gLTEpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGdldE51bVBhZEtleVN5bShldnQpIHtcbiAgICAgICAgaWYgKG51bUxvY2tPbktleUNvZGVzLmluZGV4T2YoZXZ0LmtleUNvZGUpICE9PSAtMSkge1xuICAgICAgICAgICAgcmV0dXJuIG51bUxvY2tPbktleVN5bXNbZXZ0LmNvZGVdO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiAwO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHByb2Nlc3MoZXZ0LCB0eXBlKSB7XG4gICAgICAgIHZhciByZXN1bHQgPSB7dHlwZTogdHlwZX07XG4gICAgICAgIHJlc3VsdC5jb2RlID0gZXZ0LmNvZGU7XG4gICAgICAgIHJlc3VsdC5rZXlzeW0gPSAwO1xuXG4gICAgICAgIGlmIChpc051bVBhZE11bHRpS2V5KGV2dCkpIHtcbiAgICAgICAgICAgIHJlc3VsdC5rZXlzeW0gPSBnZXROdW1QYWRLZXlTeW0oZXZ0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBoYXNNb2RpZmllciA9IG1vZGlmaWVyU3RhdGUuaGFzU2hvcnRjdXRNb2RpZmllcigpIHx8ICEhbW9kaWZpZXJTdGF0ZS5hY3RpdmVDaGFyTW9kaWZpZXIoKTtcbiAgICAgICAgdmFyIGlzU2hpZnQgPSBldnQua2V5Q29kZSA9PT0gMHgxMCB8fCBldnQua2V5ID09PSAnU2hpZnQnO1xuXG4gICAgICAgIHZhciBzdXBwcmVzcyA9ICFpc1NoaWZ0ICYmICh0eXBlICE9PSAna2V5ZG93bicgfHwgbW9kaWZpZXJTdGF0ZS5oYXNTaG9ydGN1dE1vZGlmaWVyKCkgfHwgISFLZXlib2FyZFV0aWwubm9uQ2hhcmFjdGVyS2V5KGV2dCkpO1xuXG4gICAgICAgIG5leHQocmVzdWx0KTtcbiAgICAgICAgcmV0dXJuIHN1cHByZXNzO1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgICBrZXlkb3duOiBmdW5jdGlvbihldnQpIHtcbiAgICAgICAgICAgIHNlbmRBbGwobW9kaWZpZXJTdGF0ZS5rZXlkb3duKGV2dCkpO1xuICAgICAgICAgICAgcmV0dXJuIHByb2Nlc3MoZXZ0LCAna2V5ZG93bicpO1xuICAgICAgICB9LFxuICAgICAgICBrZXlwcmVzczogZnVuY3Rpb24oZXZ0KSB7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcbiAgICAgICAga2V5dXA6IGZ1bmN0aW9uKGV2dCkge1xuICAgICAgICAgICAgc2VuZEFsbChtb2RpZmllclN0YXRlLmtleXVwKGV2dCkpO1xuICAgICAgICAgICAgcmV0dXJuIHByb2Nlc3MoZXZ0LCAna2V5dXAnKTtcbiAgICAgICAgfSxcbiAgICAgICAgc3luY01vZGlmaWVyczogZnVuY3Rpb24oZXZ0KSB7XG4gICAgICAgICAgICBzZW5kQWxsKG1vZGlmaWVyU3RhdGUuc3luY0FueShldnQpKTtcbiAgICAgICAgfSxcbiAgICAgICAgcmVsZWFzZUFsbDogZnVuY3Rpb24oKSB7IG5leHQoe3R5cGU6ICdyZWxlYXNlYWxsJ30pOyB9XG4gICAgfTtcbn07XG5cbktleWJvYXJkVXRpbC5UcmFja1FFTVVLZXlTdGF0ZSA9IGZ1bmN0aW9uKG5leHQpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcbiAgICB2YXIgc3RhdGUgPSBbXTtcblxuICAgIHJldHVybiBmdW5jdGlvbiAoZXZ0KSB7XG4gICAgICAgIHZhciBsYXN0ID0gc3RhdGUubGVuZ3RoICE9PSAwID8gc3RhdGVbc3RhdGUubGVuZ3RoLTFdIDogbnVsbDtcblxuICAgICAgICBzd2l0Y2ggKGV2dC50eXBlKSB7XG4gICAgICAgIGNhc2UgJ2tleWRvd24nOlxuXG4gICAgICAgICAgICBpZiAoIWxhc3QgfHwgbGFzdC5jb2RlICE9PSBldnQuY29kZSkge1xuICAgICAgICAgICAgICAgIGxhc3QgPSB7Y29kZTogZXZ0LmNvZGV9O1xuXG4gICAgICAgICAgICAgICAgaWYgKHN0YXRlLmxlbmd0aCA+IDAgJiYgc3RhdGVbc3RhdGUubGVuZ3RoLTFdLmNvZGUgPT0gJ0NvbnRyb2xMZWZ0Jykge1xuICAgICAgICAgICAgICAgICAgICAgaWYgKGV2dC5jb2RlICE9PSAnQWx0UmlnaHQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgbmV4dCh7Y29kZTogJ0NvbnRyb2xMZWZ0JywgdHlwZTogJ2tleWRvd24nLCBrZXlzeW06IDB9KTtcbiAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgc3RhdGUucG9wKCk7XG4gICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHN0YXRlLnB1c2gobGFzdCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoZXZ0LmNvZGUgIT09ICdDb250cm9sTGVmdCcpIHtcbiAgICAgICAgICAgICAgICBuZXh0KGV2dCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdrZXl1cCc6XG4gICAgICAgICAgICBpZiAoc3RhdGUubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdmFyIGlkeCA9IG51bGw7XG4gICAgICAgICAgICAvLyBkbyB3ZSBoYXZlIGEgbWF0Y2hpbmcga2V5IHRyYWNrZWQgYXMgYmVpbmcgZG93bj9cbiAgICAgICAgICAgIGZvciAodmFyIGkgPSAwOyBpICE9PSBzdGF0ZS5sZW5ndGg7ICsraSkge1xuICAgICAgICAgICAgICAgIGlmIChzdGF0ZVtpXS5jb2RlID09PSBldnQuY29kZSkge1xuICAgICAgICAgICAgICAgICAgICBpZHggPSBpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBpZiB3ZSBjb3VsZG4ndCBmaW5kIGEgbWF0Y2ggKGl0IGhhcHBlbnMpLCBhc3N1bWUgaXQgd2FzIHRoZSBsYXN0IGtleSBwcmVzc2VkXG4gICAgICAgICAgICBpZiAoaWR4ID09PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgaWYgKGV2dC5jb2RlID09PSAnQ29udHJvbExlZnQnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWR4ID0gc3RhdGUubGVuZ3RoIC0gMTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3RhdGUuc3BsaWNlKGlkeCwgMSk7XG4gICAgICAgICAgICBuZXh0KGV2dCk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAncmVsZWFzZWFsbCc6XG4gICAgICAgICAgICAvKiBqc2hpbnQgc2hhZG93OiB0cnVlICovXG4gICAgICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHN0YXRlLmxlbmd0aDsgKytpKSB7XG4gICAgICAgICAgICAgICAgbmV4dCh7Y29kZTogc3RhdGVbaV0uY29kZSwga2V5c3ltOiAwLCB0eXBlOiAna2V5dXAnfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvKiBqc2hpbnQgc2hhZG93OiBmYWxzZSAqL1xuICAgICAgICAgICAgc3RhdGUgPSBbXTtcbiAgICAgICAgfVxuICAgIH07XG59O1xuXG4vLyBUYWtlcyBhIERPTSBrZXlib2FyZCBldmVudCBhbmQ6XG4vLyAtIGRldGVybWluZXMgd2hpY2gga2V5c3ltIGl0IHJlcHJlc2VudHNcbi8vIC0gZGV0ZXJtaW5lcyBhIGtleUlkICBpZGVudGlmeWluZyB0aGUga2V5IHRoYXQgd2FzIHByZXNzZWQgKGNvcnJlc3BvbmRpbmcgdG8gdGhlIGtleS9rZXlDb2RlIHByb3BlcnRpZXMgb24gdGhlIERPTSBldmVudClcbi8vIC0gc3ludGhlc2l6ZXMgZXZlbnRzIHRvIHN5bmNocm9uaXplIG1vZGlmaWVyIGtleSBzdGF0ZSBiZXR3ZWVuIHdoaWNoIG1vZGlmaWVycyBhcmUgYWN0dWFsbHkgZG93biwgYW5kIHdoaWNoIHdlIHRob3VnaHQgd2VyZSBkb3duXG4vLyAtIG1hcmtzIGVhY2ggZXZlbnQgd2l0aCBhbiAnZXNjYXBlJyBwcm9wZXJ0eSBpZiBhIG1vZGlmaWVyIHdhcyBkb3duIHdoaWNoIHNob3VsZCBiZSBcImVzY2FwZWRcIlxuLy8gLSBnZW5lcmF0ZXMgYSBcInN0YWxsXCIgZXZlbnQgaW4gY2FzZXMgd2hlcmUgaXQgbWlnaHQgYmUgbmVjZXNzYXJ5IHRvIHdhaXQgYW5kIHNlZSBpZiBhIGtleXByZXNzIGV2ZW50IGZvbGxvd3MgYSBrZXlkb3duXG4vLyBUaGlzIGluZm9ybWF0aW9uIGlzIGNvbGxlY3RlZCBpbnRvIGFuIG9iamVjdCB3aGljaCBpcyBwYXNzZWQgdG8gdGhlIG5leHQoKSBmdW5jdGlvbi4gKG9uZSBjYWxsIHBlciBldmVudClcbktleWJvYXJkVXRpbC5LZXlFdmVudERlY29kZXIgPSBmdW5jdGlvbihtb2RpZmllclN0YXRlLCBuZXh0KSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG4gICAgZnVuY3Rpb24gc2VuZEFsbChldnRzKSB7XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZXZ0cy5sZW5ndGg7ICsraSkge1xuICAgICAgICAgICAgbmV4dChldnRzW2ldKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBmdW5jdGlvbiBwcm9jZXNzKGV2dCwgdHlwZSkge1xuICAgICAgICB2YXIgcmVzdWx0ID0ge3R5cGU6IHR5cGV9O1xuICAgICAgICB2YXIga2V5SWQgPSBLZXlib2FyZFV0aWwuZ2V0S2V5KGV2dCk7XG4gICAgICAgIGlmIChrZXlJZCkge1xuICAgICAgICAgICAgcmVzdWx0LmtleUlkID0ga2V5SWQ7XG4gICAgICAgIH1cblxuICAgICAgICB2YXIga2V5c3ltID0gS2V5Ym9hcmRVdGlsLmdldEtleXN5bShldnQpO1xuXG4gICAgICAgIHZhciBoYXNNb2RpZmllciA9IG1vZGlmaWVyU3RhdGUuaGFzU2hvcnRjdXRNb2RpZmllcigpIHx8ICEhbW9kaWZpZXJTdGF0ZS5hY3RpdmVDaGFyTW9kaWZpZXIoKTtcbiAgICAgICAgLy8gSXMgdGhpcyBhIGNhc2Ugd2hlcmUgd2UgaGF2ZSB0byBkZWNpZGUgb24gdGhlIGtleXN5bSByaWdodCBhd2F5LCByYXRoZXIgdGhhbiB3YWl0aW5nIGZvciB0aGUga2V5cHJlc3M/XG4gICAgICAgIC8vIFwic3BlY2lhbFwiIGtleXMgbGlrZSBlbnRlciwgdGFiIG9yIGJhY2tzcGFjZSBkb24ndCBzZW5kIGtleXByZXNzIGV2ZW50cyxcbiAgICAgICAgLy8gYW5kIHNvbWUgYnJvd3NlcnMgZG9uJ3Qgc2VuZCBrZXlwcmVzc2VzIGF0IGFsbCBpZiBhIG1vZGlmaWVyIGlzIGRvd25cbiAgICAgICAgaWYgKGtleXN5bSAmJiAodHlwZSAhPT0gJ2tleWRvd24nIHx8IEtleWJvYXJkVXRpbC5ub25DaGFyYWN0ZXJLZXkoZXZ0KSB8fCBoYXNNb2RpZmllcikpIHtcbiAgICAgICAgICAgIHJlc3VsdC5rZXlzeW0gPSBrZXlzeW07XG4gICAgICAgIH1cblxuICAgICAgICB2YXIgaXNTaGlmdCA9IGV2dC5rZXlDb2RlID09PSAweDEwIHx8IGV2dC5rZXkgPT09ICdTaGlmdCc7XG5cbiAgICAgICAgLy8gU2hvdWxkIHdlIHByZXZlbnQgdGhlIGJyb3dzZXIgZnJvbSBoYW5kbGluZyB0aGUgZXZlbnQ/XG4gICAgICAgIC8vIERvaW5nIHNvIG9uIGEga2V5ZG93biAoaW4gbW9zdCBicm93c2VycykgcHJldmVudHMga2V5cHJlc3MgZnJvbSBiZWluZyBnZW5lcmF0ZWRcbiAgICAgICAgLy8gc28gb25seSBkbyB0aGF0IGlmIHdlIGhhdmUgdG8uXG4gICAgICAgIHZhciBzdXBwcmVzcyA9ICFpc1NoaWZ0ICYmICh0eXBlICE9PSAna2V5ZG93bicgfHwgbW9kaWZpZXJTdGF0ZS5oYXNTaG9ydGN1dE1vZGlmaWVyKCkgfHwgISFLZXlib2FyZFV0aWwubm9uQ2hhcmFjdGVyS2V5KGV2dCkpO1xuXG4gICAgICAgIC8vIElmIGEgY2hhciBtb2RpZmllciBpcyBkb3duIG9uIGEga2V5ZG93biwgd2UgbmVlZCB0byBpbnNlcnQgYSBzdGFsbCxcbiAgICAgICAgLy8gc28gVmVyaWZ5Q2hhck1vZGlmaWVyIGtub3dzIHRvIHdhaXQgYW5kIHNlZSBpZiBhIGtleXByZXNzIGlzIGNvbW5pZ1xuICAgICAgICB2YXIgc3RhbGwgPSB0eXBlID09PSAna2V5ZG93bicgJiYgbW9kaWZpZXJTdGF0ZS5hY3RpdmVDaGFyTW9kaWZpZXIoKSAmJiAhS2V5Ym9hcmRVdGlsLm5vbkNoYXJhY3RlcktleShldnQpO1xuXG4gICAgICAgIC8vIGlmIGEgY2hhciBtb2RpZmllciBpcyBwcmVzc2VkLCBnZXQgdGhlIGtleXMgaXQgY29uc2lzdHMgb2YgKG9uIFdpbmRvd3MsIEFsdEdyIGlzIGVxdWl2YWxlbnQgdG8gQ3RybCtBbHQpXG4gICAgICAgIHZhciBhY3RpdmUgPSBtb2RpZmllclN0YXRlLmFjdGl2ZUNoYXJNb2RpZmllcigpO1xuXG4gICAgICAgIC8vIElmIHdlIGhhdmUgYSBjaGFyIG1vZGlmaWVyIGRvd24sIGFuZCB3ZSdyZSBhYmxlIHRvIGRldGVybWluZSBhIGtleXN5bSByZWxpYWJseVxuICAgICAgICAvLyB0aGVuIChhKSB3ZSBrbm93IHRvIHRyZWF0IHRoZSBtb2RpZmllciBhcyBhIGNoYXIgbW9kaWZpZXIsXG4gICAgICAgIC8vIGFuZCAoYikgd2UnbGwgaGF2ZSB0byBcImVzY2FwZVwiIHRoZSBtb2RpZmllciB0byB1bmRvIHRoZSBtb2RpZmllciB3aGVuIHNlbmRpbmcgdGhlIGNoYXIuXG4gICAgICAgIGlmIChhY3RpdmUgJiYga2V5c3ltKSB7XG4gICAgICAgICAgICB2YXIgaXNDaGFyTW9kaWZpZXIgPSBmYWxzZTtcbiAgICAgICAgICAgIGZvciAodmFyIGkgID0gMDsgaSA8IGFjdGl2ZS5sZW5ndGg7ICsraSkge1xuICAgICAgICAgICAgICAgIGlmIChhY3RpdmVbaV0gPT09IGtleXN5bS5rZXlzeW0pIHtcbiAgICAgICAgICAgICAgICAgICAgaXNDaGFyTW9kaWZpZXIgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh0eXBlID09PSAna2V5cHJlc3MnICYmICFpc0NoYXJNb2RpZmllcikge1xuICAgICAgICAgICAgICAgIHJlc3VsdC5lc2NhcGUgPSBtb2RpZmllclN0YXRlLmFjdGl2ZUNoYXJNb2RpZmllcigpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHN0YWxsKSB7XG4gICAgICAgICAgICAvLyBpbnNlcnQgYSBmYWtlIFwic3RhbGxcIiBldmVudFxuICAgICAgICAgICAgbmV4dCh7dHlwZTogJ3N0YWxsJ30pO1xuICAgICAgICB9XG4gICAgICAgIG5leHQocmVzdWx0KTtcblxuICAgICAgICByZXR1cm4gc3VwcHJlc3M7XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgICAga2V5ZG93bjogZnVuY3Rpb24oZXZ0KSB7XG4gICAgICAgICAgICBzZW5kQWxsKG1vZGlmaWVyU3RhdGUua2V5ZG93bihldnQpKTtcbiAgICAgICAgICAgIHJldHVybiBwcm9jZXNzKGV2dCwgJ2tleWRvd24nKTtcbiAgICAgICAgfSxcbiAgICAgICAga2V5cHJlc3M6IGZ1bmN0aW9uKGV2dCkge1xuICAgICAgICAgICAgcmV0dXJuIHByb2Nlc3MoZXZ0LCAna2V5cHJlc3MnKTtcbiAgICAgICAgfSxcbiAgICAgICAga2V5dXA6IGZ1bmN0aW9uKGV2dCkge1xuICAgICAgICAgICAgc2VuZEFsbChtb2RpZmllclN0YXRlLmtleXVwKGV2dCkpO1xuICAgICAgICAgICAgcmV0dXJuIHByb2Nlc3MoZXZ0LCAna2V5dXAnKTtcbiAgICAgICAgfSxcbiAgICAgICAgc3luY01vZGlmaWVyczogZnVuY3Rpb24oZXZ0KSB7XG4gICAgICAgICAgICBzZW5kQWxsKG1vZGlmaWVyU3RhdGUuc3luY0FueShldnQpKTtcbiAgICAgICAgfSxcbiAgICAgICAgcmVsZWFzZUFsbDogZnVuY3Rpb24oKSB7IG5leHQoe3R5cGU6ICdyZWxlYXNlYWxsJ30pOyB9XG4gICAgfTtcbn07XG5cbi8vIENvbWJpbmVzIGtleWRvd24gYW5kIGtleXByZXNzIGV2ZW50cyB3aGVyZSBuZWNlc3NhcnkgdG8gaGFuZGxlIGNoYXIgbW9kaWZpZXJzLlxuLy8gT24gc29tZSBPUydlcywgYSBjaGFyIG1vZGlmaWVyIGlzIHNvbWV0aW1lcyB1c2VkIGFzIGEgc2hvcnRjdXQgbW9kaWZpZXIuXG4vLyBGb3IgZXhhbXBsZSwgb24gV2luZG93cywgQWx0R3IgaXMgc3lub255bW91cyB3aXRoIEN0cmwtQWx0LiBPbiBhIERhbmlzaCBrZXlib2FyZCBsYXlvdXQsIEFsdEdyLTIgeWllbGRzIGEgQCwgYnV0IEN0cmwtQWx0LUQgZG9lcyBub3RoaW5nXG4vLyBzbyB3aGVuIHVzZWQgd2l0aCB0aGUgJzInIGtleSwgQ3RybC1BbHQgY291bnRzIGFzIGEgY2hhciBtb2RpZmllciAoYW5kIHNob3VsZCBiZSBlc2NhcGVkKSwgYnV0IHdoZW4gdXNlZCB3aXRoICdEJywgaXQgZG9lcyBub3QuXG4vLyBUaGUgb25seSB3YXkgd2UgY2FuIGRpc3Rpbmd1aXNoIHRoZXNlIGNhc2VzIGlzIHRvIHdhaXQgYW5kIHNlZSBpZiBhIGtleXByZXNzIGV2ZW50IGFycml2ZXNcbi8vIFdoZW4gd2UgcmVjZWl2ZSBhIFwic3RhbGxcIiBldmVudCwgd2FpdCBhIGZldyBtcyBiZWZvcmUgcHJvY2Vzc2luZyB0aGUgbmV4dCBrZXlkb3duLiBJZiBhIGtleXByZXNzIGhhcyBhbHNvIGFycml2ZWQsIG1lcmdlIHRoZSB0d29cbktleWJvYXJkVXRpbC5WZXJpZnlDaGFyTW9kaWZpZXIgPSBmdW5jdGlvbihuZXh0KSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG4gICAgdmFyIHF1ZXVlID0gW107XG4gICAgdmFyIHRpbWVyID0gbnVsbDtcbiAgICBmdW5jdGlvbiBwcm9jZXNzKCkge1xuICAgICAgICBpZiAodGltZXIpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBkZWxheVByb2Nlc3MgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICAgICAgdGltZXIgPSBudWxsO1xuICAgICAgICAgICAgcHJvY2VzcygpO1xuICAgICAgICB9O1xuXG4gICAgICAgIHdoaWxlIChxdWV1ZS5sZW5ndGggIT09IDApIHtcbiAgICAgICAgICAgIHZhciBjdXIgPSBxdWV1ZVswXTtcbiAgICAgICAgICAgIHF1ZXVlID0gcXVldWUuc3BsaWNlKDEpO1xuICAgICAgICAgICAgc3dpdGNoIChjdXIudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnc3RhbGwnOlxuICAgICAgICAgICAgICAgIC8vIGluc2VydCBhIGRlbGF5IGJlZm9yZSBwcm9jZXNzaW5nIGF2YWlsYWJsZSBldmVudHMuXG4gICAgICAgICAgICAgICAgLyoganNoaW50IGxvb3BmdW5jOiB0cnVlICovXG4gICAgICAgICAgICAgICAgdGltZXIgPSBzZXRUaW1lb3V0KGRlbGF5UHJvY2VzcywgNSk7XG4gICAgICAgICAgICAgICAgLyoganNoaW50IGxvb3BmdW5jOiBmYWxzZSAqL1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIGNhc2UgJ2tleWRvd24nOlxuICAgICAgICAgICAgICAgIC8vIGlzIHRoZSBuZXh0IGVsZW1lbnQgYSBrZXlwcmVzcz8gVGhlbiB3ZSBzaG91bGQgbWVyZ2UgdGhlIHR3b1xuICAgICAgICAgICAgICAgIGlmIChxdWV1ZS5sZW5ndGggIT09IDAgJiYgcXVldWVbMF0udHlwZSA9PT0gJ2tleXByZXNzJykge1xuICAgICAgICAgICAgICAgICAgICAvLyBGaXJlZm94IHNlbmRzIGtleXByZXNzIGV2ZW4gd2hlbiBubyBjaGFyIGlzIGdlbmVyYXRlZC5cbiAgICAgICAgICAgICAgICAgICAgLy8gc28sIGlmIGtleXByZXNzIGtleXN5bSBpcyB0aGUgc2FtZSBhcyB3ZSdkIGhhdmUgZ3Vlc3NlZCBmcm9tIGtleWRvd24sXG4gICAgICAgICAgICAgICAgICAgIC8vIHRoZSBtb2RpZmllciBkaWRuJ3QgaGF2ZSBhbnkgZWZmZWN0LCBhbmQgc2hvdWxkIG5vdCBiZSBlc2NhcGVkXG4gICAgICAgICAgICAgICAgICAgIGlmIChxdWV1ZVswXS5lc2NhcGUgJiYgKCFjdXIua2V5c3ltIHx8IGN1ci5rZXlzeW0ua2V5c3ltICE9PSBxdWV1ZVswXS5rZXlzeW0ua2V5c3ltKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY3VyLmVzY2FwZSA9IHF1ZXVlWzBdLmVzY2FwZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBjdXIua2V5c3ltID0gcXVldWVbMF0ua2V5c3ltO1xuICAgICAgICAgICAgICAgICAgICBxdWV1ZSA9IHF1ZXVlLnNwbGljZSgxKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIHN3YWxsb3cgc3RhbGwgZXZlbnRzLCBhbmQgcGFzcyBhbGwgb3RoZXJzIHRvIHRoZSBuZXh0IHN0YWdlXG4gICAgICAgICAgICBpZiAoY3VyLnR5cGUgIT09ICdzdGFsbCcpIHtcbiAgICAgICAgICAgICAgICBuZXh0KGN1cik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGZ1bmN0aW9uKGV2dCkge1xuICAgICAgICBxdWV1ZS5wdXNoKGV2dCk7XG4gICAgICAgIHByb2Nlc3MoKTtcbiAgICB9O1xufTtcblxuLy8gS2VlcHMgdHJhY2sgb2Ygd2hpY2gga2V5cyB3ZSAoYW5kIHRoZSBzZXJ2ZXIpIGJlbGlldmUgYXJlIGRvd25cbi8vIFdoZW4gYSBrZXl1cCBpcyByZWNlaXZlZCwgbWF0Y2ggaXQgYWdhaW5zdCB0aGlzIGxpc3QsIHRvIGRldGVybWluZSB0aGUgY29ycmVzcG9uZGluZyBrZXlzeW0ocylcbi8vIGluIHNvbWUgY2FzZXMsIGEgc2luZ2xlIGtleSBtYXkgcHJvZHVjZSBtdWx0aXBsZSBrZXlzeW1zLCBzbyB0aGUgY29ycmVzcG9uZGluZyBrZXl1cCBldmVudCBtdXN0IHJlbGVhc2UgYWxsIG9mIHRoZXNlIGNoYXJzXG4vLyBrZXkgcmVwZWF0IGV2ZW50cyBzaG91bGQgYmUgbWVyZ2VkIGludG8gYSBzaW5nbGUgZW50cnkuXG4vLyBCZWNhdXNlIHdlIGNhbid0IGFsd2F5cyBpZGVudGlmeSB3aGljaCBlbnRyeSBhIGtleWRvd24gb3Iga2V5dXAgZXZlbnQgY29ycmVzcG9uZHMgdG8sIHdlIHNvbWV0aW1lcyBoYXZlIHRvIGd1ZXNzXG5LZXlib2FyZFV0aWwuVHJhY2tLZXlTdGF0ZSA9IGZ1bmN0aW9uKG5leHQpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcbiAgICB2YXIgc3RhdGUgPSBbXTtcblxuICAgIHJldHVybiBmdW5jdGlvbiAoZXZ0KSB7XG4gICAgICAgIHZhciBsYXN0ID0gc3RhdGUubGVuZ3RoICE9PSAwID8gc3RhdGVbc3RhdGUubGVuZ3RoLTFdIDogbnVsbDtcblxuICAgICAgICBzd2l0Y2ggKGV2dC50eXBlKSB7XG4gICAgICAgIGNhc2UgJ2tleWRvd24nOlxuICAgICAgICAgICAgLy8gaW5zZXJ0IGEgbmV3IGVudHJ5IGlmIGxhc3Qgc2VlbiBrZXkgd2FzIGRpZmZlcmVudC5cbiAgICAgICAgICAgIGlmICghbGFzdCB8fCAhZXZ0LmtleUlkIHx8IGxhc3Qua2V5SWQgIT09IGV2dC5rZXlJZCkge1xuICAgICAgICAgICAgICAgIGxhc3QgPSB7a2V5SWQ6IGV2dC5rZXlJZCwga2V5c3ltczoge319O1xuICAgICAgICAgICAgICAgIHN0YXRlLnB1c2gobGFzdCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoZXZ0LmtleXN5bSkge1xuICAgICAgICAgICAgICAgIC8vIG1ha2Ugc3VyZSBsYXN0IGV2ZW50IGNvbnRhaW5zIHRoaXMga2V5c3ltIChhIHNpbmdsZSBcImxvZ2ljYWxcIiBrZXlldmVudFxuICAgICAgICAgICAgICAgIC8vIGNhbiBjYXVzZSBtdWx0aXBsZSBrZXkgZXZlbnRzIHRvIGJlIHNlbnQgdG8gdGhlIFZOQyBzZXJ2ZXIpXG4gICAgICAgICAgICAgICAgbGFzdC5rZXlzeW1zW2V2dC5rZXlzeW0ua2V5c3ltXSA9IGV2dC5rZXlzeW07XG4gICAgICAgICAgICAgICAgbGFzdC5pZ25vcmVLZXlQcmVzcyA9IHRydWU7XG4gICAgICAgICAgICAgICAgbmV4dChldnQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ2tleXByZXNzJzpcbiAgICAgICAgICAgIGlmICghbGFzdCkge1xuICAgICAgICAgICAgICAgIGxhc3QgPSB7a2V5SWQ6IGV2dC5rZXlJZCwga2V5c3ltczoge319O1xuICAgICAgICAgICAgICAgIHN0YXRlLnB1c2gobGFzdCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIWV2dC5rZXlzeW0pIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygna2V5cHJlc3Mgd2l0aCBubyBrZXlzeW06JywgZXZ0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gSWYgd2UgZGlkbid0IGV4cGVjdCBhIGtleXByZXNzLCBhbmQgYWxyZWFkeSBzZW50IGEga2V5ZG93biB0byB0aGUgVk5DIHNlcnZlclxuICAgICAgICAgICAgLy8gYmFzZWQgb24gdGhlIGtleWRvd24sIG1ha2Ugc3VyZSB0byBza2lwIHRoaXMgZXZlbnQuXG4gICAgICAgICAgICBpZiAoZXZ0LmtleXN5bSAmJiAhbGFzdC5pZ25vcmVLZXlQcmVzcykge1xuICAgICAgICAgICAgICAgIGxhc3Qua2V5c3ltc1tldnQua2V5c3ltLmtleXN5bV0gPSBldnQua2V5c3ltO1xuICAgICAgICAgICAgICAgIGV2dC50eXBlID0gJ2tleWRvd24nO1xuICAgICAgICAgICAgICAgIG5leHQoZXZ0KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdrZXl1cCc6XG4gICAgICAgICAgICBpZiAoc3RhdGUubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdmFyIGlkeCA9IG51bGw7XG4gICAgICAgICAgICAvLyBkbyB3ZSBoYXZlIGEgbWF0Y2hpbmcga2V5IHRyYWNrZWQgYXMgYmVpbmcgZG93bj9cbiAgICAgICAgICAgIGZvciAodmFyIGkgPSAwOyBpICE9PSBzdGF0ZS5sZW5ndGg7ICsraSkge1xuICAgICAgICAgICAgICAgIGlmIChzdGF0ZVtpXS5rZXlJZCA9PT0gZXZ0LmtleUlkKSB7XG4gICAgICAgICAgICAgICAgICAgIGlkeCA9IGk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIGlmIHdlIGNvdWxkbid0IGZpbmQgYSBtYXRjaCAoaXQgaGFwcGVucyksIGFzc3VtZSBpdCB3YXMgdGhlIGxhc3Qga2V5IHByZXNzZWRcbiAgICAgICAgICAgIGlmIChpZHggPT09IG51bGwpIHtcbiAgICAgICAgICAgICAgICBpZHggPSBzdGF0ZS5sZW5ndGggLSAxO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YXIgaXRlbSA9IHN0YXRlLnNwbGljZShpZHgsIDEpWzBdO1xuICAgICAgICAgICAgLy8gZm9yIGVhY2gga2V5c3ltIHRyYWNrZWQgYnkgdGhpcyBrZXkgZW50cnksIGNsb25lIHRoZSBjdXJyZW50IGV2ZW50IGFuZCBvdmVycmlkZSB0aGUga2V5c3ltXG4gICAgICAgICAgICB2YXIgY2xvbmUgPSAoZnVuY3Rpb24oKXtcbiAgICAgICAgICAgICAgICBmdW5jdGlvbiBDbG9uZSgpe31cbiAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKG9iaikgeyBDbG9uZS5wcm90b3R5cGU9b2JqOyByZXR1cm4gbmV3IENsb25lKCk7IH07XG4gICAgICAgICAgICB9KCkpO1xuICAgICAgICAgICAgZm9yICh2YXIga2V5IGluIGl0ZW0ua2V5c3ltcykge1xuICAgICAgICAgICAgICAgIHZhciBvdXQgPSBjbG9uZShldnQpO1xuICAgICAgICAgICAgICAgIG91dC5rZXlzeW0gPSBpdGVtLmtleXN5bXNba2V5XTtcbiAgICAgICAgICAgICAgICBuZXh0KG91dCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAncmVsZWFzZWFsbCc6XG4gICAgICAgICAgICAvKiBqc2hpbnQgc2hhZG93OiB0cnVlICovXG4gICAgICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHN0YXRlLmxlbmd0aDsgKytpKSB7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIga2V5IGluIHN0YXRlW2ldLmtleXN5bXMpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGtleXN5bSA9IHN0YXRlW2ldLmtleXN5bXNba2V5XTtcbiAgICAgICAgICAgICAgICAgICAgbmV4dCh7a2V5SWQ6IDAsIGtleXN5bToga2V5c3ltLCB0eXBlOiAna2V5dXAnfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLyoganNoaW50IHNoYWRvdzogZmFsc2UgKi9cbiAgICAgICAgICAgIHN0YXRlID0gW107XG4gICAgICAgIH1cbiAgICB9O1xufTtcblxuLy8gSGFuZGxlcyBcImVzY2FwaW5nXCIgb2YgbW9kaWZpZXJzOiBpZiBhIGNoYXIgbW9kaWZpZXIgaXMgdXNlZCB0byBwcm9kdWNlIGEga2V5c3ltIChzdWNoIGFzIEFsdEdyLTIgdG8gZ2VuZXJhdGUgYW4gQCksXG4vLyB0aGVuIHRoZSBtb2RpZmllciBtdXN0IGJlIFwidW5kb25lXCIgYmVmb3JlIHNlbmRpbmcgdGhlIEAsIGFuZCBcInJlZG9uZVwiIGFmdGVyd2FyZHMuXG5LZXlib2FyZFV0aWwuRXNjYXBlTW9kaWZpZXJzID0gZnVuY3Rpb24obmV4dCkge1xuICAgIFwidXNlIHN0cmljdFwiO1xuICAgIHJldHVybiBmdW5jdGlvbihldnQpIHtcbiAgICAgICAgaWYgKGV2dC50eXBlICE9PSAna2V5ZG93bicgfHwgZXZ0LmVzY2FwZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICBuZXh0KGV2dCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgLy8gdW5kbyBtb2RpZmllcnNcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBldnQuZXNjYXBlLmxlbmd0aDsgKytpKSB7XG4gICAgICAgICAgICBuZXh0KHt0eXBlOiAna2V5dXAnLCBrZXlJZDogMCwga2V5c3ltOiBrZXlzeW1zLmxvb2t1cChldnQuZXNjYXBlW2ldKX0pO1xuICAgICAgICB9XG4gICAgICAgIC8vIHNlbmQgdGhlIGNoYXJhY3RlciBldmVudFxuICAgICAgICBuZXh0KGV2dCk7XG4gICAgICAgIC8vIHJlZG8gbW9kaWZpZXJzXG4gICAgICAgIC8qIGpzaGludCBzaGFkb3c6IHRydWUgKi9cbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBldnQuZXNjYXBlLmxlbmd0aDsgKytpKSB7XG4gICAgICAgICAgICBuZXh0KHt0eXBlOiAna2V5ZG93bicsIGtleUlkOiAwLCBrZXlzeW06IGtleXN5bXMubG9va3VwKGV2dC5lc2NhcGVbaV0pfSk7XG4gICAgICAgIH1cbiAgICAgICAgLyoganNoaW50IHNoYWRvdzogZmFsc2UgKi9cbiAgICB9O1xufTtcblxuZXhwb3J0IGRlZmF1bHQgS2V5Ym9hcmRVdGlsO1xuIl19