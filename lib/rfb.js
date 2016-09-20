"use strict";

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.default = RFB;

var _util = require("./util");

var _util2 = _interopRequireDefault(_util);

var _display = require("./display");

var _display2 = _interopRequireDefault(_display);

var _devices = require("./input/devices");

var _websock = require("./websock");

var _websock2 = _interopRequireDefault(_websock);

var _base = require("./base64");

var _base2 = _interopRequireDefault(_base);

var _des = require("./des");

var _des2 = _interopRequireDefault(_des);

var _keysym = require("./input/keysym");

var _keysym2 = _interopRequireDefault(_keysym);

var _xtscancodes = require("./input/xtscancodes");

var _xtscancodes2 = _interopRequireDefault(_xtscancodes);

var _inflator = require("./inflator.mod");

var _inflator2 = _interopRequireDefault(_inflator);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/*jslint white: false, browser: true */
/*global window, Util, Display, Keyboard, Mouse, Websock, Websock_native, Base64, DES, KeyTable, Inflator, XtScancode */

function RFB(defaults) {
    "use strict";

    if (!defaults) {
        defaults = {};
    }

    this._rfb_host = '';
    this._rfb_port = 5900;
    this._rfb_password = '';
    this._rfb_path = '';

    this._rfb_state = 'disconnected';
    this._rfb_version = 0;
    this._rfb_max_version = 3.8;
    this._rfb_auth_scheme = '';

    this._rfb_tightvnc = false;
    this._rfb_xvp_ver = 0;

    // In preference order
    this._encodings = [['COPYRECT', 0x01], ['TIGHT', 0x07], ['TIGHT_PNG', -260], ['HEXTILE', 0x05], ['RRE', 0x02], ['RAW', 0x00],

    // Psuedo-encoding settings

    //['JPEG_quality_lo',     -32 ],
    ['JPEG_quality_med', -26],
    //['JPEG_quality_hi',     -23 ],
    //['compress_lo',        -255 ],
    ['compress_hi', -247], ['DesktopSize', -223], ['last_rect', -224], ['Cursor', -239], ['QEMUExtendedKeyEvent', -258], ['ExtendedDesktopSize', -308], ['xvp', -309], ['Fence', -312], ['ContinuousUpdates', -313]];

    this._encHandlers = {};
    this._encNames = {};
    this._encStats = {};

    this._sock = null; // Websock object
    this._display = null; // Display object
    this._keyboard = null; // Keyboard input handler object
    this._mouse = null; // Mouse input handler object
    this._disconnTimer = null; // disconnection timer
    this._msgTimer = null; // queued handle_msg timer

    this._supportsFence = false;

    this._supportsContinuousUpdates = false;
    this._enabledContinuousUpdates = false;

    // Frame buffer update state
    this._FBU = {
        rects: 0,
        subrects: 0, // RRE
        lines: 0, // RAW
        tiles: 0, // HEXTILE
        bytes: 0,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        encoding: 0,
        subencoding: -1,
        background: null,
        zlib: [] // TIGHT zlib streams
    };

    this._fb_Bpp = 4;
    this._fb_depth = 3;
    this._fb_width = 0;
    this._fb_height = 0;
    this._fb_name = "";

    this._destBuff = null;
    this._paletteBuff = new Uint8Array(1024); // 256 * 4 (max palette size * max bytes-per-pixel)

    this._rre_chunk_sz = 100;

    this._timing = {
        last_fbu: 0,
        fbu_total: 0,
        fbu_total_cnt: 0,
        full_fbu_total: 0,
        full_fbu_cnt: 0,

        fbu_rt_start: 0,
        fbu_rt_total: 0,
        fbu_rt_cnt: 0,
        pixels: 0
    };

    this._supportsSetDesktopSize = false;
    this._screen_id = 0;
    this._screen_flags = 0;

    // Mouse state
    this._mouse_buttonMask = 0;
    this._mouse_arr = [];
    this._viewportDragging = false;
    this._viewportDragPos = {};
    this._viewportHasMoved = false;

    // QEMU Extended Key Event support - default to false
    this._qemuExtKeyEventSupported = false;

    // set the default value on user-facing properties
    _util2.default.set_defaults(this, defaults, {
        'target': 'null', // VNC display rendering Canvas object
        'focusContainer': document, // DOM element that captures keyboard input
        'encrypt': false, // Use TLS/SSL/wss encryption
        'true_color': true, // Request true color pixel data
        'local_cursor': false, // Request locally rendered cursor
        'shared': true, // Request shared mode
        'view_only': false, // Disable client mouse/keyboard
        'xvp_password_sep': '@', // Separator for XVP password fields
        'disconnectTimeout': 3, // Time (s) to wait for disconnection
        'wsProtocols': ['binary'], // Protocols to use in the WebSocket connection
        'repeaterID': '', // [UltraVNC] RepeaterID to connect to
        'viewportDrag': false, // Move the viewport on mouse drags

        // Callback functions
        'onUpdateState': function () {}, // onUpdateState(rfb, state, oldstate, statusMsg): state update/change
        'onPasswordRequired': function () {}, // onPasswordRequired(rfb): VNC password is required
        'onClipboard': function () {}, // onClipboard(rfb, text): RFB clipboard contents received
        'onBell': function () {}, // onBell(rfb): RFB Bell message received
        'onFBUReceive': function () {}, // onFBUReceive(rfb, fbu): RFB FBU received but not yet processed
        'onFBUComplete': function () {}, // onFBUComplete(rfb, fbu): RFB FBU received and processed
        'onFBResize': function () {}, // onFBResize(rfb, width, height): frame buffer resized
        'onDesktopName': function () {}, // onDesktopName(rfb, name): desktop name received
        'onXvpInit': function () {} // onXvpInit(version): XVP extensions active for this connection
    });

    // main setup
    _util2.default.Debug(">> RFB.constructor");

    // populate encHandlers with bound versions
    Object.keys(RFB.encodingHandlers).forEach(function (encName) {
        this._encHandlers[encName] = RFB.encodingHandlers[encName].bind(this);
    }.bind(this));

    // Create lookup tables based on encoding number
    for (var i = 0; i < this._encodings.length; i++) {
        this._encHandlers[this._encodings[i][1]] = this._encHandlers[this._encodings[i][0]];
        this._encNames[this._encodings[i][1]] = this._encodings[i][0];
        this._encStats[this._encodings[i][1]] = [0, 0];
    }

    // NB: nothing that needs explicit teardown should be done
    // before this point, since this can throw an exception
    try {
        this._display = new _display2.default({ target: this._target });
    } catch (exc) {
        _util2.default.Error("Display exception: " + exc);
        throw exc;
    }

    this._keyboard = new _devices.Keyboard({ target: this._focusContainer,
        onKeyPress: this._handleKeyPress.bind(this) });

    this._mouse = new _devices.Mouse({ target: this._target,
        onMouseButton: this._handleMouseButton.bind(this),
        onMouseMove: this._handleMouseMove.bind(this),
        notify: this._keyboard.sync.bind(this._keyboard) });

    this._sock = new _websock2.default();
    this._sock.on('message', this._handle_message.bind(this));
    this._sock.on('open', function () {
        if (this._rfb_state === 'connect') {
            this._updateState('ProtocolVersion', "Starting VNC handshake");
        } else {
            this._fail("Got unexpected WebSocket connection");
        }
    }.bind(this));
    this._sock.on('close', function (e) {
        _util2.default.Warn("WebSocket on-close event");
        var msg = "";
        if (e.code) {
            msg = " (code: " + e.code;
            if (e.reason) {
                msg += ", reason: " + e.reason;
            }
            msg += ")";
        }
        if (this._rfb_state === 'disconnect') {
            this._updateState('disconnected', 'VNC disconnected' + msg);
        } else if (this._rfb_state === 'ProtocolVersion') {
            this._fail('Failed to connect to server' + msg);
        } else if (this._rfb_state in { 'failed': 1, 'disconnected': 1 }) {
            _util2.default.Error("Received onclose while disconnected" + msg);
        } else {
            this._fail("Server disconnected" + msg);
        }
        this._sock.off('close');
    }.bind(this));
    this._sock.on('error', function (e) {
        _util2.default.Warn("WebSocket on-error event");
    });

    this._init_vars();

    var rmode = this._display.get_render_mode();
    _util2.default.Info("Using native WebSockets");
    this._updateState('loaded', 'noVNC ready: native WebSockets, ' + rmode);

    _util2.default.Debug("<< RFB.constructor");
} /*
   * noVNC: HTML5 VNC client
   * Copyright (C) 2012 Joel Martin
   * Copyright (C) 2016 Samuel Mannehed for Cendio AB
   * Licensed under MPL 2.0 (see LICENSE.txt)
   *
   * See README.md for usage and integration instructions.
   *
   * TIGHT decoder portion:
   * (c) 2012 Michael Tinglof, Joe Balaz, Les Piech (Mercuri.ca)
   */

;

(function () {
    RFB.prototype = {
        // Public methods
        connect: function (host, port, password, path) {
            this._rfb_host = host;
            this._rfb_port = port;
            this._rfb_password = password !== undefined ? password : "";
            this._rfb_path = path !== undefined ? path : "";

            if (!this._rfb_host || !this._rfb_port) {
                return this._fail("Must set host and port");
            }

            this._updateState('connect');
            return true;
        },

        disconnect: function () {
            this._updateState('disconnect', 'Disconnecting');
            this._sock.off('error');
            this._sock.off('message');
            this._sock.off('open');
        },

        sendPassword: function (passwd) {
            this._rfb_password = passwd;
            this._rfb_state = 'Authentication';
            setTimeout(this._init_msg.bind(this), 0);
        },

        sendCtrlAltDel: function () {
            if (this._rfb_state !== 'normal' || this._view_only) {
                return false;
            }
            _util2.default.Info("Sending Ctrl-Alt-Del");

            RFB.messages.keyEvent(this._sock, _keysym2.default.XK_Control_L, 1);
            RFB.messages.keyEvent(this._sock, _keysym2.default.XK_Alt_L, 1);
            RFB.messages.keyEvent(this._sock, _keysym2.default.XK_Delete, 1);
            RFB.messages.keyEvent(this._sock, _keysym2.default.XK_Delete, 0);
            RFB.messages.keyEvent(this._sock, _keysym2.default.XK_Alt_L, 0);
            RFB.messages.keyEvent(this._sock, _keysym2.default.XK_Control_L, 0);
            return true;
        },

        xvpOp: function (ver, op) {
            if (this._rfb_xvp_ver < ver) {
                return false;
            }
            _util2.default.Info("Sending XVP operation " + op + " (version " + ver + ")");
            this._sock.send_string("\xFA\x00" + String.fromCharCode(ver) + String.fromCharCode(op));
            return true;
        },

        xvpShutdown: function () {
            return this.xvpOp(1, 2);
        },

        xvpReboot: function () {
            return this.xvpOp(1, 3);
        },

        xvpReset: function () {
            return this.xvpOp(1, 4);
        },

        // Send a key press. If 'down' is not specified then send a down key
        // followed by an up key.
        sendKey: function (code, down) {
            if (this._rfb_state !== "normal" || this._view_only) {
                return false;
            }
            if (typeof down !== 'undefined') {
                _util2.default.Info("Sending key code (" + (down ? "down" : "up") + "): " + code);
                RFB.messages.keyEvent(this._sock, code, down ? 1 : 0);
            } else {
                _util2.default.Info("Sending key code (down + up): " + code);
                RFB.messages.keyEvent(this._sock, code, 1);
                RFB.messages.keyEvent(this._sock, code, 0);
            }
            return true;
        },

        clipboardPasteFrom: function (text) {
            if (this._rfb_state !== 'normal') {
                return;
            }
            RFB.messages.clientCutText(this._sock, text);
        },

        // Requests a change of remote desktop size. This message is an extension
        // and may only be sent if we have received an ExtendedDesktopSize message
        requestDesktopSize: function (width, height) {
            if (this._rfb_state !== "normal") {
                return;
            }

            if (this._supportsSetDesktopSize) {
                RFB.messages.setDesktopSize(this._sock, width, height, this._screen_id, this._screen_flags);
                this._sock.flush();
            }
        },

        // Private methods

        _connect: function () {
            _util2.default.Debug(">> RFB.connect");

            var uri;
            if (typeof UsingSocketIO !== 'undefined') {
                uri = 'http';
            } else {
                uri = this._encrypt ? 'wss' : 'ws';
            }

            uri += '://' + this._rfb_host + ':' + this._rfb_port + '/' + this._rfb_path;
            _util2.default.Info("connecting to " + uri);

            this._sock.open(uri, this._wsProtocols);

            _util2.default.Debug("<< RFB.connect");
        },

        _init_vars: function () {
            // reset state
            this._FBU.rects = 0;
            this._FBU.subrects = 0; // RRE and HEXTILE
            this._FBU.lines = 0; // RAW
            this._FBU.tiles = 0; // HEXTILE
            this._FBU.zlibs = []; // TIGHT zlib encoders
            this._mouse_buttonMask = 0;
            this._mouse_arr = [];
            this._rfb_tightvnc = false;

            // Clear the per connection encoding stats
            var i;
            for (i = 0; i < this._encodings.length; i++) {
                this._encStats[this._encodings[i][1]][0] = 0;
            }

            for (i = 0; i < 4; i++) {
                this._FBU.zlibs[i] = new _inflator2.default.Inflate();
            }
        },

        _print_stats: function () {
            _util2.default.Info("Encoding stats for this connection:");
            var i, s;
            for (i = 0; i < this._encodings.length; i++) {
                s = this._encStats[this._encodings[i][1]];
                if (s[0] + s[1] > 0) {
                    _util2.default.Info("    " + this._encodings[i][0] + ": " + s[0] + " rects");
                }
            }

            _util2.default.Info("Encoding stats since page load:");
            for (i = 0; i < this._encodings.length; i++) {
                s = this._encStats[this._encodings[i][1]];
                _util2.default.Info("    " + this._encodings[i][0] + ": " + s[1] + " rects");
            }
        },

        _cleanupSocket: function (state) {
            if (this._msgTimer) {
                clearInterval(this._msgTimer);
                this._msgTimer = null;
            }

            if (this._display && this._display.get_context()) {
                this._keyboard.ungrab();
                this._mouse.ungrab();
                if (state !== 'connect' && state !== 'loaded') {
                    this._display.defaultCursor();
                }
                if (_util2.default.get_logging() !== 'debug' || state === 'loaded') {
                    // Show noVNC logo on load and when disconnected, unless in
                    // debug mode
                    this._display.clear();
                }
            }

            this._sock.close();
        },

        /*
         * Page states:
         *   loaded       - page load, equivalent to disconnected
         *   disconnected - idle state
         *   connect      - starting to connect (to ProtocolVersion)
         *   normal       - connected
         *   disconnect   - starting to disconnect
         *   failed       - abnormal disconnect
         *   fatal        - failed to load page, or fatal error
         *
         * RFB protocol initialization states:
         *   ProtocolVersion
         *   Security
         *   Authentication
         *   password     - waiting for password, not part of RFB
         *   SecurityResult
         *   ClientInitialization - not triggered by server message
         *   ServerInitialization (to normal)
         */
        _updateState: function (state, statusMsg) {
            var oldstate = this._rfb_state;

            if (state === oldstate) {
                // Already here, ignore
                _util2.default.Debug("Already in state '" + state + "', ignoring");
            }

            /*
             * These are disconnected states. A previous connect may
             * asynchronously cause a connection so make sure we are closed.
             */
            if (state in { 'disconnected': 1, 'loaded': 1, 'connect': 1,
                'disconnect': 1, 'failed': 1, 'fatal': 1 }) {
                this._cleanupSocket(state);
            }

            if (oldstate === 'fatal') {
                _util2.default.Error('Fatal error, cannot continue');
            }

            var cmsg = typeof statusMsg !== 'undefined' ? " Msg: " + statusMsg : "";
            var fullmsg = "New state '" + state + "', was '" + oldstate + "'." + cmsg;
            if (state === 'failed' || state === 'fatal') {
                _util2.default.Error(cmsg);
            } else {
                _util2.default.Warn(cmsg);
            }

            if (oldstate === 'failed' && state === 'disconnected') {
                // do disconnect action, but stay in failed state
                this._rfb_state = 'failed';
            } else {
                this._rfb_state = state;
            }

            if (this._disconnTimer && this._rfb_state !== 'disconnect') {
                _util2.default.Debug("Clearing disconnect timer");
                clearTimeout(this._disconnTimer);
                this._disconnTimer = null;
                this._sock.off('close'); // make sure we don't get a double event
            }

            switch (state) {
                case 'normal':
                    if (oldstate === 'disconnected' || oldstate === 'failed') {
                        _util2.default.Error("Invalid transition from 'disconnected' or 'failed' to 'normal'");
                    }
                    break;

                case 'connect':
                    this._init_vars();
                    this._connect();
                    // WebSocket.onopen transitions to 'ProtocolVersion'
                    break;

                case 'disconnect':
                    this._disconnTimer = setTimeout(function () {
                        this._fail("Disconnect timeout");
                    }.bind(this), this._disconnectTimeout * 1000);

                    this._print_stats();

                    // WebSocket.onclose transitions to 'disconnected'
                    break;

                case 'failed':
                    if (oldstate === 'disconnected') {
                        _util2.default.Error("Invalid transition from 'disconnected' to 'failed'");
                    } else if (oldstate === 'normal') {
                        _util2.default.Error("Error while connected.");
                    } else if (oldstate === 'init') {
                        _util2.default.Error("Error while initializing.");
                    }

                    // Make sure we transition to disconnected
                    setTimeout(function () {
                        this._updateState('disconnected');
                    }.bind(this), 50);

                    break;

                default:
                // No state change action to take
            }

            if (oldstate === 'failed' && state === 'disconnected') {
                this._onUpdateState(this, state, oldstate);
            } else {
                this._onUpdateState(this, state, oldstate, statusMsg);
            }
        },

        _fail: function (msg) {
            this._updateState('failed', msg);
            return false;
        },

        _handle_message: function () {
            if (this._sock.rQlen() === 0) {
                _util2.default.Warn("handle_message called on an empty receive queue");
                return;
            }

            switch (this._rfb_state) {
                case 'disconnected':
                case 'failed':
                    _util2.default.Error("Got data while disconnected");
                    break;
                case 'normal':
                    if (this._normal_msg() && this._sock.rQlen() > 0) {
                        // true means we can continue processing
                        // Give other events a chance to run
                        if (this._msgTimer === null) {
                            _util2.default.Debug("More data to process, creating timer");
                            this._msgTimer = setTimeout(function () {
                                this._msgTimer = null;
                                this._handle_message();
                            }.bind(this), 0);
                        } else {
                            _util2.default.Debug("More data to process, existing timer");
                        }
                    }
                    break;
                default:
                    this._init_msg();
                    break;
            }
        },

        _handleKeyPress: function (keyevent) {
            if (this._view_only) {
                return;
            } // View only, skip keyboard, events

            var down = keyevent.type == 'keydown';
            if (this._qemuExtKeyEventSupported) {
                var scancode = _xtscancodes2.default[keyevent.code];
                if (scancode) {
                    var keysym = keyevent.keysym;
                    RFB.messages.QEMUExtendedKeyEvent(this._sock, keysym, down, scancode);
                } else {
                    _util2.default.Error('Unable to find a xt scancode for code = ' + keyevent.code);
                }
            } else {
                keysym = keyevent.keysym.keysym;
                RFB.messages.keyEvent(this._sock, keysym, down);
            }
        },

        _handleMouseButton: function (x, y, down, bmask) {
            if (down) {
                this._mouse_buttonMask |= bmask;
            } else {
                this._mouse_buttonMask ^= bmask;
            }

            if (this._viewportDrag) {
                if (down && !this._viewportDragging) {
                    this._viewportDragging = true;
                    this._viewportDragPos = { 'x': x, 'y': y };

                    // Skip sending mouse events
                    return;
                } else {
                    this._viewportDragging = false;

                    // If the viewport didn't actually move, then treat as a mouse click event
                    // Send the button down event here, as the button up event is sent at the end of this function
                    if (!this._viewportHasMoved && !this._view_only) {
                        RFB.messages.pointerEvent(this._sock, this._display.absX(x), this._display.absY(y), bmask);
                    }
                    this._viewportHasMoved = false;
                }
            }

            if (this._view_only) {
                return;
            } // View only, skip mouse events

            if (this._rfb_state !== "normal") {
                return;
            }
            RFB.messages.pointerEvent(this._sock, this._display.absX(x), this._display.absY(y), this._mouse_buttonMask);
        },

        _handleMouseMove: function (x, y) {
            if (this._viewportDragging) {
                var deltaX = this._viewportDragPos.x - x;
                var deltaY = this._viewportDragPos.y - y;

                // The goal is to trigger on a certain physical width, the
                // devicePixelRatio brings us a bit closer but is not optimal.
                var dragThreshold = 10 * (window.devicePixelRatio || 1);

                if (this._viewportHasMoved || Math.abs(deltaX) > dragThreshold || Math.abs(deltaY) > dragThreshold) {
                    this._viewportHasMoved = true;

                    this._viewportDragPos = { 'x': x, 'y': y };
                    this._display.viewportChangePos(deltaX, deltaY);
                }

                // Skip sending mouse events
                return;
            }

            if (this._view_only) {
                return;
            } // View only, skip mouse events

            if (this._rfb_state !== "normal") {
                return;
            }
            RFB.messages.pointerEvent(this._sock, this._display.absX(x), this._display.absY(y), this._mouse_buttonMask);
        },

        // Message Handlers

        _negotiate_protocol_version: function () {
            if (this._sock.rQlen() < 12) {
                return this._fail("Incomplete protocol version");
            }

            var sversion = this._sock.rQshiftStr(12).substr(4, 7);
            _util2.default.Info("Server ProtocolVersion: " + sversion);
            var is_repeater = 0;
            switch (sversion) {
                case "000.000":
                    // UltraVNC repeater
                    is_repeater = 1;
                    break;
                case "003.003":
                case "003.006": // UltraVNC
                case "003.889":
                    // Apple Remote Desktop
                    this._rfb_version = 3.3;
                    break;
                case "003.007":
                    this._rfb_version = 3.7;
                    break;
                case "003.008":
                case "004.000": // Intel AMT KVM
                case "004.001": // RealVNC 4.6
                case "005.000":
                    // RealVNC 5.3
                    this._rfb_version = 3.8;
                    break;
                default:
                    return this._fail("Invalid server version " + sversion);
            }

            if (is_repeater) {
                var repeaterID = this._repeaterID;
                while (repeaterID.length < 250) {
                    repeaterID += "\0";
                }
                this._sock.send_string(repeaterID);
                return true;
            }

            if (this._rfb_version > this._rfb_max_version) {
                this._rfb_version = this._rfb_max_version;
            }

            var cversion = "00" + parseInt(this._rfb_version, 10) + ".00" + this._rfb_version * 10 % 10;
            this._sock.send_string("RFB " + cversion + "\n");
            this._updateState('Security', 'Sent ProtocolVersion: ' + cversion);
        },

        _negotiate_security: function () {
            if (this._rfb_version >= 3.7) {
                // Server sends supported list, client decides
                var num_types = this._sock.rQshift8();
                if (this._sock.rQwait("security type", num_types, 1)) {
                    return false;
                }

                if (num_types === 0) {
                    var strlen = this._sock.rQshift32();
                    var reason = this._sock.rQshiftStr(strlen);
                    return this._fail("Security failure: " + reason);
                }

                this._rfb_auth_scheme = 0;
                var types = this._sock.rQshiftBytes(num_types);
                _util2.default.Debug("Server security types: " + types);
                for (var i = 0; i < types.length; i++) {
                    if (types[i] > this._rfb_auth_scheme && (types[i] <= 16 || types[i] == 22)) {
                        this._rfb_auth_scheme = types[i];
                    }
                }

                if (this._rfb_auth_scheme === 0) {
                    return this._fail("Unsupported security types: " + types);
                }

                this._sock.send([this._rfb_auth_scheme]);
            } else {
                // Server decides
                if (this._sock.rQwait("security scheme", 4)) {
                    return false;
                }
                this._rfb_auth_scheme = this._sock.rQshift32();
            }

            this._updateState('Authentication', 'Authenticating using scheme: ' + this._rfb_auth_scheme);
            return this._init_msg(); // jump to authentication
        },

        // authentication
        _negotiate_xvp_auth: function () {
            var xvp_sep = this._xvp_password_sep;
            var xvp_auth = this._rfb_password.split(xvp_sep);
            if (xvp_auth.length < 3) {
                this._updateState('password', 'XVP credentials required (user' + xvp_sep + 'target' + xvp_sep + 'password) -- got only ' + this._rfb_password);
                this._onPasswordRequired(this);
                return false;
            }

            var xvp_auth_str = String.fromCharCode(xvp_auth[0].length) + String.fromCharCode(xvp_auth[1].length) + xvp_auth[0] + xvp_auth[1];
            this._sock.send_string(xvp_auth_str);
            this._rfb_password = xvp_auth.slice(2).join(xvp_sep);
            this._rfb_auth_scheme = 2;
            return this._negotiate_authentication();
        },

        _negotiate_std_vnc_auth: function () {
            if (this._rfb_password.length === 0) {
                // Notify via both callbacks since it's kind of
                // an RFB state change and a UI interface issue
                this._updateState('password', "Password Required");
                this._onPasswordRequired(this);
                return false;
            }

            if (this._sock.rQwait("auth challenge", 16)) {
                return false;
            }

            // TODO(directxman12): make genDES not require an Array
            var challenge = Array.prototype.slice.call(this._sock.rQshiftBytes(16));
            var response = RFB.genDES(this._rfb_password, challenge);
            this._sock.send(response);
            this._updateState("SecurityResult");
            return true;
        },

        _negotiate_tight_tunnels: function (numTunnels) {
            var clientSupportedTunnelTypes = {
                0: { vendor: 'TGHT', signature: 'NOTUNNEL' }
            };
            var serverSupportedTunnelTypes = {};
            // receive tunnel capabilities
            for (var i = 0; i < numTunnels; i++) {
                var cap_code = this._sock.rQshift32();
                var cap_vendor = this._sock.rQshiftStr(4);
                var cap_signature = this._sock.rQshiftStr(8);
                serverSupportedTunnelTypes[cap_code] = { vendor: cap_vendor, signature: cap_signature };
            }

            // choose the notunnel type
            if (serverSupportedTunnelTypes[0]) {
                if (serverSupportedTunnelTypes[0].vendor != clientSupportedTunnelTypes[0].vendor || serverSupportedTunnelTypes[0].signature != clientSupportedTunnelTypes[0].signature) {
                    return this._fail("Client's tunnel type had the incorrect vendor or signature");
                }
                this._sock.send([0, 0, 0, 0]); // use NOTUNNEL
                return false; // wait until we receive the sub auth count to continue
            } else {
                return this._fail("Server wanted tunnels, but doesn't support the notunnel type");
            }
        },

        _negotiate_tight_auth: function () {
            if (!this._rfb_tightvnc) {
                // first pass, do the tunnel negotiation
                if (this._sock.rQwait("num tunnels", 4)) {
                    return false;
                }
                var numTunnels = this._sock.rQshift32();
                if (numTunnels > 0 && this._sock.rQwait("tunnel capabilities", 16 * numTunnels, 4)) {
                    return false;
                }

                this._rfb_tightvnc = true;

                if (numTunnels > 0) {
                    this._negotiate_tight_tunnels(numTunnels);
                    return false; // wait until we receive the sub auth to continue
                }
            }

            // second pass, do the sub-auth negotiation
            if (this._sock.rQwait("sub auth count", 4)) {
                return false;
            }
            var subAuthCount = this._sock.rQshift32();
            if (subAuthCount === 0) {
                // empty sub-auth list received means 'no auth' subtype selected
                this._updateState('SecurityResult');
                return true;
            }

            if (this._sock.rQwait("sub auth capabilities", 16 * subAuthCount, 4)) {
                return false;
            }

            var clientSupportedTypes = {
                'STDVNOAUTH__': 1,
                'STDVVNCAUTH_': 2
            };

            var serverSupportedTypes = [];

            for (var i = 0; i < subAuthCount; i++) {
                var capNum = this._sock.rQshift32();
                var capabilities = this._sock.rQshiftStr(12);
                serverSupportedTypes.push(capabilities);
            }

            for (var authType in clientSupportedTypes) {
                if (serverSupportedTypes.indexOf(authType) != -1) {
                    this._sock.send([0, 0, 0, clientSupportedTypes[authType]]);

                    switch (authType) {
                        case 'STDVNOAUTH__':
                            // no auth
                            this._updateState('SecurityResult');
                            return true;
                        case 'STDVVNCAUTH_':
                            // VNC auth
                            this._rfb_auth_scheme = 2;
                            return this._init_msg();
                        default:
                            return this._fail("Unsupported tiny auth scheme: " + authType);
                    }
                }
            }

            return this._fail("No supported sub-auth types!");
        },

        _negotiate_authentication: function () {
            switch (this._rfb_auth_scheme) {
                case 0:
                    // connection failed
                    if (this._sock.rQwait("auth reason", 4)) {
                        return false;
                    }
                    var strlen = this._sock.rQshift32();
                    var reason = this._sock.rQshiftStr(strlen);
                    return this._fail("Auth failure: " + reason);

                case 1:
                    // no auth
                    if (this._rfb_version >= 3.8) {
                        this._updateState('SecurityResult');
                        return true;
                    }
                    this._updateState('ClientInitialisation', "No auth required");
                    return this._init_msg();

                case 22:
                    // XVP auth
                    return this._negotiate_xvp_auth();

                case 2:
                    // VNC authentication
                    return this._negotiate_std_vnc_auth();

                case 16:
                    // TightVNC Security Type
                    return this._negotiate_tight_auth();

                default:
                    return this._fail("Unsupported auth scheme: " + this._rfb_auth_scheme);
            }
        },

        _handle_security_result: function () {
            if (this._sock.rQwait('VNC auth response ', 4)) {
                return false;
            }
            switch (this._sock.rQshift32()) {
                case 0:
                    // OK
                    this._updateState('ClientInitialisation', 'Authentication OK');
                    return this._init_msg();
                case 1:
                    // failed
                    if (this._rfb_version >= 3.8) {
                        var length = this._sock.rQshift32();
                        if (this._sock.rQwait("SecurityResult reason", length, 8)) {
                            return false;
                        }
                        var reason = this._sock.rQshiftStr(length);
                        return this._fail(reason);
                    } else {
                        return this._fail("Authentication failure");
                    }
                    return false;
                case 2:
                    return this._fail("Too many auth attempts");
                default:
                    return this._fail("Unknown SecurityResult");
            }
        },

        _negotiate_server_init: function () {
            if (this._sock.rQwait("server initialization", 24)) {
                return false;
            }

            /* Screen size */
            this._fb_width = this._sock.rQshift16();
            this._fb_height = this._sock.rQshift16();
            this._destBuff = new Uint8Array(this._fb_width * this._fb_height * 4);

            /* PIXEL_FORMAT */
            var bpp = this._sock.rQshift8();
            var depth = this._sock.rQshift8();
            var big_endian = this._sock.rQshift8();
            var true_color = this._sock.rQshift8();

            var red_max = this._sock.rQshift16();
            var green_max = this._sock.rQshift16();
            var blue_max = this._sock.rQshift16();
            var red_shift = this._sock.rQshift8();
            var green_shift = this._sock.rQshift8();
            var blue_shift = this._sock.rQshift8();
            this._sock.rQskipBytes(3); // padding

            // NB(directxman12): we don't want to call any callbacks or print messages until
            //                   *after* we're past the point where we could backtrack

            /* Connection name/title */
            var name_length = this._sock.rQshift32();
            if (this._sock.rQwait('server init name', name_length, 24)) {
                return false;
            }
            this._fb_name = _util2.default.decodeUTF8(this._sock.rQshiftStr(name_length));

            if (this._rfb_tightvnc) {
                if (this._sock.rQwait('TightVNC extended server init header', 8, 24 + name_length)) {
                    return false;
                }
                // In TightVNC mode, ServerInit message is extended
                var numServerMessages = this._sock.rQshift16();
                var numClientMessages = this._sock.rQshift16();
                var numEncodings = this._sock.rQshift16();
                this._sock.rQskipBytes(2); // padding

                var totalMessagesLength = (numServerMessages + numClientMessages + numEncodings) * 16;
                if (this._sock.rQwait('TightVNC extended server init header', totalMessagesLength, 32 + name_length)) {
                    return false;
                }

                // we don't actually do anything with the capability information that TIGHT sends,
                // so we just skip the all of this.

                // TIGHT server message capabilities
                this._sock.rQskipBytes(16 * numServerMessages);

                // TIGHT client message capabilities
                this._sock.rQskipBytes(16 * numClientMessages);

                // TIGHT encoding capabilities
                this._sock.rQskipBytes(16 * numEncodings);
            }

            // NB(directxman12): these are down here so that we don't run them multiple times
            //                   if we backtrack
            _util2.default.Info("Screen: " + this._fb_width + "x" + this._fb_height + ", bpp: " + bpp + ", depth: " + depth + ", big_endian: " + big_endian + ", true_color: " + true_color + ", red_max: " + red_max + ", green_max: " + green_max + ", blue_max: " + blue_max + ", red_shift: " + red_shift + ", green_shift: " + green_shift + ", blue_shift: " + blue_shift);

            if (big_endian !== 0) {
                _util2.default.Warn("Server native endian is not little endian");
            }

            if (red_shift !== 16) {
                _util2.default.Warn("Server native red-shift is not 16");
            }

            if (blue_shift !== 0) {
                _util2.default.Warn("Server native blue-shift is not 0");
            }

            // we're past the point where we could backtrack, so it's safe to call this
            this._onDesktopName(this, this._fb_name);

            if (this._true_color && this._fb_name === "Intel(r) AMT KVM") {
                _util2.default.Warn("Intel AMT KVM only supports 8/16 bit depths.  Disabling true color");
                this._true_color = false;
            }

            this._display.set_true_color(this._true_color);
            this._display.resize(this._fb_width, this._fb_height);
            this._onFBResize(this, this._fb_width, this._fb_height);
            this._keyboard.grab();
            this._mouse.grab();

            if (this._true_color) {
                this._fb_Bpp = 4;
                this._fb_depth = 3;
            } else {
                this._fb_Bpp = 1;
                this._fb_depth = 1;
            }

            RFB.messages.pixelFormat(this._sock, this._fb_Bpp, this._fb_depth, this._true_color);
            RFB.messages.clientEncodings(this._sock, this._encodings, this._local_cursor, this._true_color);
            RFB.messages.fbUpdateRequests(this._sock, false, this._display.getCleanDirtyReset(), this._fb_width, this._fb_height);

            this._timing.fbu_rt_start = new Date().getTime();
            this._timing.pixels = 0;

            if (this._encrypt) {
                this._updateState('normal', 'Connected (encrypted) to: ' + this._fb_name);
            } else {
                this._updateState('normal', 'Connected (unencrypted) to: ' + this._fb_name);
            }
            return true;
        },

        _init_msg: function () {
            switch (this._rfb_state) {
                case 'ProtocolVersion':
                    return this._negotiate_protocol_version();

                case 'Security':
                    return this._negotiate_security();

                case 'Authentication':
                    return this._negotiate_authentication();

                case 'SecurityResult':
                    return this._handle_security_result();

                case 'ClientInitialisation':
                    this._sock.send([this._shared ? 1 : 0]); // ClientInitialisation
                    this._updateState('ServerInitialisation', "Authentication OK");
                    return true;

                case 'ServerInitialisation':
                    return this._negotiate_server_init();

                default:
                    return this._fail("Unknown state: " + this._rfb_state);
            }
        },

        _handle_set_colour_map_msg: function () {
            _util2.default.Debug("SetColorMapEntries");
            this._sock.rQskip8(); // Padding

            var first_colour = this._sock.rQshift16();
            var num_colours = this._sock.rQshift16();
            if (this._sock.rQwait('SetColorMapEntries', num_colours * 6, 6)) {
                return false;
            }

            for (var c = 0; c < num_colours; c++) {
                var red = parseInt(this._sock.rQshift16() / 256, 10);
                var green = parseInt(this._sock.rQshift16() / 256, 10);
                var blue = parseInt(this._sock.rQshift16() / 256, 10);
                this._display.set_colourMap([blue, green, red], first_colour + c);
            }
            _util2.default.Debug("colourMap: " + this._display.get_colourMap());
            _util2.default.Info("Registered " + num_colours + " colourMap entries");

            return true;
        },

        _handle_server_cut_text: function () {
            _util2.default.Debug("ServerCutText");
            if (this._sock.rQwait("ServerCutText header", 7, 1)) {
                return false;
            }
            this._sock.rQskipBytes(3); // Padding
            var length = this._sock.rQshift32();
            if (this._sock.rQwait("ServerCutText", length, 8)) {
                return false;
            }

            var text = this._sock.rQshiftStr(length);
            this._onClipboard(this, text);

            return true;
        },

        _handle_server_fence_msg: function () {
            if (this._sock.rQwait("ServerFence header", 8, 1)) {
                return false;
            }
            this._sock.rQskipBytes(3); // Padding
            var flags = this._sock.rQshift32();
            var length = this._sock.rQshift8();

            if (this._sock.rQwait("ServerFence payload", length, 9)) {
                return false;
            }

            if (length > 64) {
                _util2.default.Warn("Bad payload length (" + length + ") in fence response");
                length = 64;
            }

            var payload = this._sock.rQshiftStr(length);

            this._supportsFence = true;

            /*
             * Fence flags
             *
             *  (1<<0)  - BlockBefore
             *  (1<<1)  - BlockAfter
             *  (1<<2)  - SyncNext
             *  (1<<31) - Request
             */

            if (!(flags & 1 << 31)) {
                return this._fail("Unexpected fence response");
            }

            // Filter out unsupported flags
            // FIXME: support syncNext
            flags &= 1 << 0 | 1 << 1;

            // BlockBefore and BlockAfter are automatically handled by
            // the fact that we process each incoming message
            // synchronuosly.
            RFB.messages.clientFence(this._sock, flags, payload);

            return true;
        },

        _handle_xvp_msg: function () {
            if (this._sock.rQwait("XVP version and message", 3, 1)) {
                return false;
            }
            this._sock.rQskip8(); // Padding
            var xvp_ver = this._sock.rQshift8();
            var xvp_msg = this._sock.rQshift8();

            switch (xvp_msg) {
                case 0:
                    // XVP_FAIL
                    this._updateState(this._rfb_state, "Operation Failed");
                    break;
                case 1:
                    // XVP_INIT
                    this._rfb_xvp_ver = xvp_ver;
                    _util2.default.Info("XVP extensions enabled (version " + this._rfb_xvp_ver + ")");
                    this._onXvpInit(this._rfb_xvp_ver);
                    break;
                default:
                    this._fail("Disconnected: illegal server XVP message " + xvp_msg);
                    break;
            }

            return true;
        },

        _normal_msg: function () {
            var msg_type;

            if (this._FBU.rects > 0) {
                msg_type = 0;
            } else {
                msg_type = this._sock.rQshift8();
            }

            switch (msg_type) {
                case 0:
                    // FramebufferUpdate
                    var ret = this._framebufferUpdate();
                    if (ret) {
                        RFB.messages.fbUpdateRequests(this._sock, this._enabledContinuousUpdates, this._display.getCleanDirtyReset(), this._fb_width, this._fb_height);
                    }
                    return ret;

                case 1:
                    // SetColorMapEntries
                    return this._handle_set_colour_map_msg();

                case 2:
                    // Bell
                    _util2.default.Debug("Bell");
                    this._onBell(this);
                    return true;

                case 3:
                    // ServerCutText
                    return this._handle_server_cut_text();

                case 150:
                    // EndOfContinuousUpdates
                    var first = !this._supportsContinuousUpdates;
                    this._supportsContinuousUpdates = true;
                    this._enabledContinuousUpdates = false;
                    if (first) {
                        this._enabledContinuousUpdates = true;
                        this._updateContinuousUpdates();
                        _util2.default.Info("Enabling continuous updates.");
                    } else {
                        // FIXME: We need to send a framebufferupdaterequest here
                        // if we add support for turning off continuous updates
                    }
                    return true;

                case 248:
                    // ServerFence
                    return this._handle_server_fence_msg();

                case 250:
                    // XVP
                    return this._handle_xvp_msg();

                default:
                    this._fail("Disconnected: illegal server message type " + msg_type);
                    _util2.default.Debug("sock.rQslice(0, 30): " + this._sock.rQslice(0, 30));
                    return true;
            }
        },

        _framebufferUpdate: function () {
            var ret = true;
            var now;

            if (this._FBU.rects === 0) {
                if (this._sock.rQwait("FBU header", 3, 1)) {
                    return false;
                }
                this._sock.rQskip8(); // Padding
                this._FBU.rects = this._sock.rQshift16();
                this._FBU.bytes = 0;
                this._timing.cur_fbu = 0;
                if (this._timing.fbu_rt_start > 0) {
                    now = new Date().getTime();
                    _util2.default.Info("First FBU latency: " + (now - this._timing.fbu_rt_start));
                }
            }

            while (this._FBU.rects > 0) {
                if (this._rfb_state !== "normal") {
                    return false;
                }

                if (this._sock.rQwait("FBU", this._FBU.bytes)) {
                    return false;
                }
                if (this._FBU.bytes === 0) {
                    if (this._sock.rQwait("rect header", 12)) {
                        return false;
                    }
                    /* New FramebufferUpdate */

                    var hdr = this._sock.rQshiftBytes(12);
                    this._FBU.x = (hdr[0] << 8) + hdr[1];
                    this._FBU.y = (hdr[2] << 8) + hdr[3];
                    this._FBU.width = (hdr[4] << 8) + hdr[5];
                    this._FBU.height = (hdr[6] << 8) + hdr[7];
                    this._FBU.encoding = parseInt((hdr[8] << 24) + (hdr[9] << 16) + (hdr[10] << 8) + hdr[11], 10);

                    this._onFBUReceive(this, { 'x': this._FBU.x, 'y': this._FBU.y,
                        'width': this._FBU.width, 'height': this._FBU.height,
                        'encoding': this._FBU.encoding,
                        'encodingName': this._encNames[this._FBU.encoding] });

                    if (!this._encNames[this._FBU.encoding]) {
                        this._fail("Disconnected: unsupported encoding " + this._FBU.encoding);
                        return false;
                    }
                }

                this._timing.last_fbu = new Date().getTime();

                ret = this._encHandlers[this._FBU.encoding]();

                now = new Date().getTime();
                this._timing.cur_fbu += now - this._timing.last_fbu;

                if (ret) {
                    this._encStats[this._FBU.encoding][0]++;
                    this._encStats[this._FBU.encoding][1]++;
                    this._timing.pixels += this._FBU.width * this._FBU.height;
                }

                if (this._timing.pixels >= this._fb_width * this._fb_height) {
                    if (this._FBU.width === this._fb_width && this._FBU.height === this._fb_height || this._timing.fbu_rt_start > 0) {
                        this._timing.full_fbu_total += this._timing.cur_fbu;
                        this._timing.full_fbu_cnt++;
                        _util2.default.Info("Timing of full FBU, curr: " + this._timing.cur_fbu + ", total: " + this._timing.full_fbu_total + ", cnt: " + this._timing.full_fbu_cnt + ", avg: " + this._timing.full_fbu_total / this._timing.full_fbu_cnt);
                    }

                    if (this._timing.fbu_rt_start > 0) {
                        var fbu_rt_diff = now - this._timing.fbu_rt_start;
                        this._timing.fbu_rt_total += fbu_rt_diff;
                        this._timing.fbu_rt_cnt++;
                        _util2.default.Info("full FBU round-trip, cur: " + fbu_rt_diff + ", total: " + this._timing.fbu_rt_total + ", cnt: " + this._timing.fbu_rt_cnt + ", avg: " + this._timing.fbu_rt_total / this._timing.fbu_rt_cnt);
                        this._timing.fbu_rt_start = 0;
                    }
                }

                if (!ret) {
                    return ret;
                } // need more data
            }

            this._onFBUComplete(this, { 'x': this._FBU.x, 'y': this._FBU.y,
                'width': this._FBU.width, 'height': this._FBU.height,
                'encoding': this._FBU.encoding,
                'encodingName': this._encNames[this._FBU.encoding] });

            return true; // We finished this FBU
        },

        _updateContinuousUpdates: function () {
            if (!this._enabledContinuousUpdates) {
                return;
            }

            RFB.messages.enableContinuousUpdates(this._sock, true, 0, 0, this._fb_width, this._fb_height);
        }
    };

    _util2.default.make_properties(RFB, [['target', 'wo', 'dom'], // VNC display rendering Canvas object
    ['focusContainer', 'wo', 'dom'], // DOM element that captures keyboard input
    ['encrypt', 'rw', 'bool'], // Use TLS/SSL/wss encryption
    ['true_color', 'rw', 'bool'], // Request true color pixel data
    ['local_cursor', 'rw', 'bool'], // Request locally rendered cursor
    ['shared', 'rw', 'bool'], // Request shared mode
    ['view_only', 'rw', 'bool'], // Disable client mouse/keyboard
    ['xvp_password_sep', 'rw', 'str'], // Separator for XVP password fields
    ['disconnectTimeout', 'rw', 'int'], // Time (s) to wait for disconnection
    ['wsProtocols', 'rw', 'arr'], // Protocols to use in the WebSocket connection
    ['repeaterID', 'rw', 'str'], // [UltraVNC] RepeaterID to connect to
    ['viewportDrag', 'rw', 'bool'], // Move the viewport on mouse drags

    // Callback functions
    ['onUpdateState', 'rw', 'func'], // onUpdateState(rfb, state, oldstate, statusMsg): RFB state update/change
    ['onPasswordRequired', 'rw', 'func'], // onPasswordRequired(rfb): VNC password is required
    ['onClipboard', 'rw', 'func'], // onClipboard(rfb, text): RFB clipboard contents received
    ['onBell', 'rw', 'func'], // onBell(rfb): RFB Bell message received
    ['onFBUReceive', 'rw', 'func'], // onFBUReceive(rfb, fbu): RFB FBU received but not yet processed
    ['onFBUComplete', 'rw', 'func'], // onFBUComplete(rfb, fbu): RFB FBU received and processed
    ['onFBResize', 'rw', 'func'], // onFBResize(rfb, width, height): frame buffer resized
    ['onDesktopName', 'rw', 'func'], // onDesktopName(rfb, name): desktop name received
    ['onXvpInit', 'rw', 'func'] // onXvpInit(version): XVP extensions active for this connection
    ]);

    RFB.prototype.set_local_cursor = function (cursor) {
        if (!cursor || cursor in { '0': 1, 'no': 1, 'false': 1 }) {
            this._local_cursor = false;
            this._display.disableLocalCursor(); //Only show server-side cursor
        } else {
            if (this._display.get_cursor_uri()) {
                this._local_cursor = true;
            } else {
                _util2.default.Warn("Browser does not support local cursor");
                this._display.disableLocalCursor();
            }
        }
    };

    RFB.prototype.get_display = function () {
        return this._display;
    };
    RFB.prototype.get_keyboard = function () {
        return this._keyboard;
    };
    RFB.prototype.get_mouse = function () {
        return this._mouse;
    };

    // Class Methods
    RFB.messages = {
        keyEvent: function (sock, keysym, down) {
            var buff = sock._sQ;
            var offset = sock._sQlen;

            buff[offset] = 4; // msg-type
            buff[offset + 1] = down;

            buff[offset + 2] = 0;
            buff[offset + 3] = 0;

            buff[offset + 4] = keysym >> 24;
            buff[offset + 5] = keysym >> 16;
            buff[offset + 6] = keysym >> 8;
            buff[offset + 7] = keysym;

            sock._sQlen += 8;
            sock.flush();
        },

        QEMUExtendedKeyEvent: function (sock, keysym, down, keycode) {
            function getRFBkeycode(xt_scancode) {
                var upperByte = keycode >> 8;
                var lowerByte = keycode & 0x00ff;
                if (upperByte === 0xe0 && lowerByte < 0x7f) {
                    lowerByte = lowerByte | 0x80;
                    return lowerByte;
                }
                return xt_scancode;
            }

            var buff = sock._sQ;
            var offset = sock._sQlen;

            buff[offset] = 255; // msg-type
            buff[offset + 1] = 0; // sub msg-type

            buff[offset + 2] = down >> 8;
            buff[offset + 3] = down;

            buff[offset + 4] = keysym >> 24;
            buff[offset + 5] = keysym >> 16;
            buff[offset + 6] = keysym >> 8;
            buff[offset + 7] = keysym;

            var RFBkeycode = getRFBkeycode(keycode);

            buff[offset + 8] = RFBkeycode >> 24;
            buff[offset + 9] = RFBkeycode >> 16;
            buff[offset + 10] = RFBkeycode >> 8;
            buff[offset + 11] = RFBkeycode;

            sock._sQlen += 12;
            sock.flush();
        },

        pointerEvent: function (sock, x, y, mask) {
            var buff = sock._sQ;
            var offset = sock._sQlen;

            buff[offset] = 5; // msg-type

            buff[offset + 1] = mask;

            buff[offset + 2] = x >> 8;
            buff[offset + 3] = x;

            buff[offset + 4] = y >> 8;
            buff[offset + 5] = y;

            sock._sQlen += 6;
            sock.flush();
        },

        // TODO(directxman12): make this unicode compatible?
        clientCutText: function (sock, text) {
            var buff = sock._sQ;
            var offset = sock._sQlen;

            buff[offset] = 6; // msg-type

            buff[offset + 1] = 0; // padding
            buff[offset + 2] = 0; // padding
            buff[offset + 3] = 0; // padding

            var n = text.length;

            buff[offset + 4] = n >> 24;
            buff[offset + 5] = n >> 16;
            buff[offset + 6] = n >> 8;
            buff[offset + 7] = n;

            for (var i = 0; i < n; i++) {
                buff[offset + 8 + i] = text.charCodeAt(i);
            }

            sock._sQlen += 8 + n;
            sock.flush();
        },

        setDesktopSize: function (sock, width, height, id, flags) {
            var buff = sock._sQ;
            var offset = sock._sQlen;

            buff[offset] = 251; // msg-type
            buff[offset + 1] = 0; // padding
            buff[offset + 2] = width >> 8; // width
            buff[offset + 3] = width;
            buff[offset + 4] = height >> 8; // height
            buff[offset + 5] = height;

            buff[offset + 6] = 1; // number-of-screens
            buff[offset + 7] = 0; // padding

            // screen array
            buff[offset + 8] = id >> 24; // id
            buff[offset + 9] = id >> 16;
            buff[offset + 10] = id >> 8;
            buff[offset + 11] = id;
            buff[offset + 12] = 0; // x-position
            buff[offset + 13] = 0;
            buff[offset + 14] = 0; // y-position
            buff[offset + 15] = 0;
            buff[offset + 16] = width >> 8; // width
            buff[offset + 17] = width;
            buff[offset + 18] = height >> 8; // height
            buff[offset + 19] = height;
            buff[offset + 20] = flags >> 24; // flags
            buff[offset + 21] = flags >> 16;
            buff[offset + 22] = flags >> 8;
            buff[offset + 23] = flags;

            sock._sQlen += 24;
            sock.flush();
        },

        clientFence: function (sock, flags, payload) {
            var buff = sock._sQ;
            var offset = sock._sQlen;

            buff[offset] = 248; // msg-type

            buff[offset + 1] = 0; // padding
            buff[offset + 2] = 0; // padding
            buff[offset + 3] = 0; // padding

            buff[offset + 4] = flags >> 24; // flags
            buff[offset + 5] = flags >> 16;
            buff[offset + 6] = flags >> 8;
            buff[offset + 7] = flags;

            var n = payload.length;

            buff[offset + 8] = n; // length

            for (var i = 0; i < n; i++) {
                buff[offset + 9 + i] = payload.charCodeAt(i);
            }

            sock._sQlen += 9 + n;
            sock.flush();
        },

        enableContinuousUpdates: function (sock, enable, x, y, width, height) {
            var buff = sock._sQ;
            var offset = sock._sQlen;

            buff[offset] = 150; // msg-type
            buff[offset + 1] = enable; // enable-flag

            buff[offset + 2] = x >> 8; // x
            buff[offset + 3] = x;
            buff[offset + 4] = y >> 8; // y
            buff[offset + 5] = y;
            buff[offset + 6] = width >> 8; // width
            buff[offset + 7] = width;
            buff[offset + 8] = height >> 8; // height
            buff[offset + 9] = height;

            sock._sQlen += 10;
            sock.flush();
        },

        pixelFormat: function (sock, bpp, depth, true_color) {
            var buff = sock._sQ;
            var offset = sock._sQlen;

            buff[offset] = 0; // msg-type

            buff[offset + 1] = 0; // padding
            buff[offset + 2] = 0; // padding
            buff[offset + 3] = 0; // padding

            buff[offset + 4] = bpp * 8; // bits-per-pixel
            buff[offset + 5] = depth * 8; // depth
            buff[offset + 6] = 0; // little-endian
            buff[offset + 7] = true_color ? 1 : 0; // true-color

            buff[offset + 8] = 0; // red-max
            buff[offset + 9] = 255; // red-max

            buff[offset + 10] = 0; // green-max
            buff[offset + 11] = 255; // green-max

            buff[offset + 12] = 0; // blue-max
            buff[offset + 13] = 255; // blue-max

            buff[offset + 14] = 16; // red-shift
            buff[offset + 15] = 8; // green-shift
            buff[offset + 16] = 0; // blue-shift

            buff[offset + 17] = 0; // padding
            buff[offset + 18] = 0; // padding
            buff[offset + 19] = 0; // padding

            sock._sQlen += 20;
            sock.flush();
        },

        clientEncodings: function (sock, encodings, local_cursor, true_color) {
            var buff = sock._sQ;
            var offset = sock._sQlen;

            buff[offset] = 2; // msg-type
            buff[offset + 1] = 0; // padding

            // offset + 2 and offset + 3 are encoding count

            var i,
                j = offset + 4,
                cnt = 0;
            for (i = 0; i < encodings.length; i++) {
                if (encodings[i][0] === "Cursor" && !local_cursor) {
                    _util2.default.Debug("Skipping Cursor pseudo-encoding");
                } else if (encodings[i][0] === "TIGHT" && !true_color) {
                    // TODO: remove this when we have tight+non-true-color
                    _util2.default.Warn("Skipping tight as it is only supported with true color");
                } else {
                    var enc = encodings[i][1];
                    buff[j] = enc >> 24;
                    buff[j + 1] = enc >> 16;
                    buff[j + 2] = enc >> 8;
                    buff[j + 3] = enc;

                    j += 4;
                    cnt++;
                }
            }

            buff[offset + 2] = cnt >> 8;
            buff[offset + 3] = cnt;

            sock._sQlen += j - offset;
            sock.flush();
        },

        fbUpdateRequests: function (sock, onlyNonInc, cleanDirty, fb_width, fb_height) {
            var offsetIncrement = 0;

            var cb = cleanDirty.cleanBox;
            var w, h;
            if (!onlyNonInc && cb.w > 0 && cb.h > 0) {
                w = typeof cb.w === "undefined" ? fb_width : cb.w;
                h = typeof cb.h === "undefined" ? fb_height : cb.h;
                // Request incremental for clean box
                RFB.messages.fbUpdateRequest(sock, 1, cb.x, cb.y, w, h);
            }

            for (var i = 0; i < cleanDirty.dirtyBoxes.length; i++) {
                var db = cleanDirty.dirtyBoxes[i];
                // Force all (non-incremental) for dirty box
                w = typeof db.w === "undefined" ? fb_width : db.w;
                h = typeof db.h === "undefined" ? fb_height : db.h;
                RFB.messages.fbUpdateRequest(sock, 0, db.x, db.y, w, h);
            }
        },

        fbUpdateRequest: function (sock, incremental, x, y, w, h) {
            var buff = sock._sQ;
            var offset = sock._sQlen;

            if (typeof x === "undefined") {
                x = 0;
            }
            if (typeof y === "undefined") {
                y = 0;
            }

            buff[offset] = 3; // msg-type
            buff[offset + 1] = incremental;

            buff[offset + 2] = x >> 8 & 0xFF;
            buff[offset + 3] = x & 0xFF;

            buff[offset + 4] = y >> 8 & 0xFF;
            buff[offset + 5] = y & 0xFF;

            buff[offset + 6] = w >> 8 & 0xFF;
            buff[offset + 7] = w & 0xFF;

            buff[offset + 8] = h >> 8 & 0xFF;
            buff[offset + 9] = h & 0xFF;

            sock._sQlen += 10;
            sock.flush();
        }
    };

    RFB.genDES = function (password, challenge) {
        var passwd = [];
        for (var i = 0; i < password.length; i++) {
            passwd.push(password.charCodeAt(i));
        }
        return new _des2.default(passwd).encrypt(challenge);
    };

    RFB.extract_data_uri = function (arr) {
        return ";base64," + _base2.default.encode(arr);
    };

    RFB.encodingHandlers = {
        RAW: function () {
            if (this._FBU.lines === 0) {
                this._FBU.lines = this._FBU.height;
            }

            this._FBU.bytes = this._FBU.width * this._fb_Bpp; // at least a line
            if (this._sock.rQwait("RAW", this._FBU.bytes)) {
                return false;
            }
            var cur_y = this._FBU.y + (this._FBU.height - this._FBU.lines);
            var curr_height = Math.min(this._FBU.lines, Math.floor(this._sock.rQlen() / (this._FBU.width * this._fb_Bpp)));
            this._display.blitImage(this._FBU.x, cur_y, this._FBU.width, curr_height, this._sock.get_rQ(), this._sock.get_rQi());
            this._sock.rQskipBytes(this._FBU.width * curr_height * this._fb_Bpp);
            this._FBU.lines -= curr_height;

            if (this._FBU.lines > 0) {
                this._FBU.bytes = this._FBU.width * this._fb_Bpp; // At least another line
            } else {
                this._FBU.rects--;
                this._FBU.bytes = 0;
            }

            return true;
        },

        COPYRECT: function () {
            this._FBU.bytes = 4;
            if (this._sock.rQwait("COPYRECT", 4)) {
                return false;
            }
            this._display.copyImage(this._sock.rQshift16(), this._sock.rQshift16(), this._FBU.x, this._FBU.y, this._FBU.width, this._FBU.height);

            this._FBU.rects--;
            this._FBU.bytes = 0;
            return true;
        },

        RRE: function () {
            var color;
            if (this._FBU.subrects === 0) {
                this._FBU.bytes = 4 + this._fb_Bpp;
                if (this._sock.rQwait("RRE", 4 + this._fb_Bpp)) {
                    return false;
                }
                this._FBU.subrects = this._sock.rQshift32();
                color = this._sock.rQshiftBytes(this._fb_Bpp); // Background
                this._display.fillRect(this._FBU.x, this._FBU.y, this._FBU.width, this._FBU.height, color);
            }

            while (this._FBU.subrects > 0 && this._sock.rQlen() >= this._fb_Bpp + 8) {
                color = this._sock.rQshiftBytes(this._fb_Bpp);
                var x = this._sock.rQshift16();
                var y = this._sock.rQshift16();
                var width = this._sock.rQshift16();
                var height = this._sock.rQshift16();
                this._display.fillRect(this._FBU.x + x, this._FBU.y + y, width, height, color);
                this._FBU.subrects--;
            }

            if (this._FBU.subrects > 0) {
                var chunk = Math.min(this._rre_chunk_sz, this._FBU.subrects);
                this._FBU.bytes = (this._fb_Bpp + 8) * chunk;
            } else {
                this._FBU.rects--;
                this._FBU.bytes = 0;
            }

            return true;
        },

        HEXTILE: function () {
            var rQ = this._sock.get_rQ();
            var rQi = this._sock.get_rQi();

            if (this._FBU.tiles === 0) {
                this._FBU.tiles_x = Math.ceil(this._FBU.width / 16);
                this._FBU.tiles_y = Math.ceil(this._FBU.height / 16);
                this._FBU.total_tiles = this._FBU.tiles_x * this._FBU.tiles_y;
                this._FBU.tiles = this._FBU.total_tiles;
            }

            while (this._FBU.tiles > 0) {
                this._FBU.bytes = 1;
                if (this._sock.rQwait("HEXTILE subencoding", this._FBU.bytes)) {
                    return false;
                }
                var subencoding = rQ[rQi]; // Peek
                if (subencoding > 30) {
                    // Raw
                    this._fail("Disconnected: illegal hextile subencoding " + subencoding);
                    return false;
                }

                var subrects = 0;
                var curr_tile = this._FBU.total_tiles - this._FBU.tiles;
                var tile_x = curr_tile % this._FBU.tiles_x;
                var tile_y = Math.floor(curr_tile / this._FBU.tiles_x);
                var x = this._FBU.x + tile_x * 16;
                var y = this._FBU.y + tile_y * 16;
                var w = Math.min(16, this._FBU.x + this._FBU.width - x);
                var h = Math.min(16, this._FBU.y + this._FBU.height - y);

                // Figure out how much we are expecting
                if (subencoding & 0x01) {
                    // Raw
                    this._FBU.bytes += w * h * this._fb_Bpp;
                } else {
                    if (subencoding & 0x02) {
                        // Background
                        this._FBU.bytes += this._fb_Bpp;
                    }
                    if (subencoding & 0x04) {
                        // Foreground
                        this._FBU.bytes += this._fb_Bpp;
                    }
                    if (subencoding & 0x08) {
                        // AnySubrects
                        this._FBU.bytes++; // Since we aren't shifting it off
                        if (this._sock.rQwait("hextile subrects header", this._FBU.bytes)) {
                            return false;
                        }
                        subrects = rQ[rQi + this._FBU.bytes - 1]; // Peek
                        if (subencoding & 0x10) {
                            // SubrectsColoured
                            this._FBU.bytes += subrects * (this._fb_Bpp + 2);
                        } else {
                            this._FBU.bytes += subrects * 2;
                        }
                    }
                }

                if (this._sock.rQwait("hextile", this._FBU.bytes)) {
                    return false;
                }

                // We know the encoding and have a whole tile
                this._FBU.subencoding = rQ[rQi];
                rQi++;
                if (this._FBU.subencoding === 0) {
                    if (this._FBU.lastsubencoding & 0x01) {
                        // Weird: ignore blanks are RAW
                        _util2.default.Debug("     Ignoring blank after RAW");
                    } else {
                        this._display.fillRect(x, y, w, h, this._FBU.background);
                    }
                } else if (this._FBU.subencoding & 0x01) {
                    // Raw
                    this._display.blitImage(x, y, w, h, rQ, rQi);
                    rQi += this._FBU.bytes - 1;
                } else {
                    if (this._FBU.subencoding & 0x02) {
                        // Background
                        if (this._fb_Bpp == 1) {
                            this._FBU.background = rQ[rQi];
                        } else {
                            // fb_Bpp is 4
                            this._FBU.background = [rQ[rQi], rQ[rQi + 1], rQ[rQi + 2], rQ[rQi + 3]];
                        }
                        rQi += this._fb_Bpp;
                    }
                    if (this._FBU.subencoding & 0x04) {
                        // Foreground
                        if (this._fb_Bpp == 1) {
                            this._FBU.foreground = rQ[rQi];
                        } else {
                            // this._fb_Bpp is 4
                            this._FBU.foreground = [rQ[rQi], rQ[rQi + 1], rQ[rQi + 2], rQ[rQi + 3]];
                        }
                        rQi += this._fb_Bpp;
                    }

                    this._display.startTile(x, y, w, h, this._FBU.background);
                    if (this._FBU.subencoding & 0x08) {
                        // AnySubrects
                        subrects = rQ[rQi];
                        rQi++;

                        for (var s = 0; s < subrects; s++) {
                            var color;
                            if (this._FBU.subencoding & 0x10) {
                                // SubrectsColoured
                                if (this._fb_Bpp === 1) {
                                    color = rQ[rQi];
                                } else {
                                    // _fb_Bpp is 4
                                    color = [rQ[rQi], rQ[rQi + 1], rQ[rQi + 2], rQ[rQi + 3]];
                                }
                                rQi += this._fb_Bpp;
                            } else {
                                color = this._FBU.foreground;
                            }
                            var xy = rQ[rQi];
                            rQi++;
                            var sx = xy >> 4;
                            var sy = xy & 0x0f;

                            var wh = rQ[rQi];
                            rQi++;
                            var sw = (wh >> 4) + 1;
                            var sh = (wh & 0x0f) + 1;

                            this._display.subTile(sx, sy, sw, sh, color);
                        }
                    }
                    this._display.finishTile();
                }
                this._sock.set_rQi(rQi);
                this._FBU.lastsubencoding = this._FBU.subencoding;
                this._FBU.bytes = 0;
                this._FBU.tiles--;
            }

            if (this._FBU.tiles === 0) {
                this._FBU.rects--;
            }

            return true;
        },

        getTightCLength: function (arr) {
            var header = 1,
                data = 0;
            data += arr[0] & 0x7f;
            if (arr[0] & 0x80) {
                header++;
                data += (arr[1] & 0x7f) << 7;
                if (arr[1] & 0x80) {
                    header++;
                    data += arr[2] << 14;
                }
            }
            return [header, data];
        },

        display_tight: function (isTightPNG) {
            if (this._fb_depth === 1) {
                this._fail("Tight protocol handler only implements true color mode");
            }

            this._FBU.bytes = 1; // compression-control byte
            if (this._sock.rQwait("TIGHT compression-control", this._FBU.bytes)) {
                return false;
            }

            var checksum = function (data) {
                var sum = 0;
                for (var i = 0; i < data.length; i++) {
                    sum += data[i];
                    if (sum > 65536) sum -= 65536;
                }
                return sum;
            };

            var resetStreams = 0;
            var streamId = -1;
            var decompress = function (data, expected) {
                for (var i = 0; i < 4; i++) {
                    if (resetStreams >> i & 1) {
                        this._FBU.zlibs[i].reset();
                        _util2.default.Info("Reset zlib stream " + i);
                    }
                }

                //var uncompressed = this._FBU.zlibs[streamId].uncompress(data, 0);
                var uncompressed = this._FBU.zlibs[streamId].inflate(data, true, expected);
                /*if (uncompressed.status !== 0) {
                    Util.Error("Invalid data in zlib stream");
                }*/

                //return uncompressed.data;
                return uncompressed;
            }.bind(this);

            var indexedToRGBX2Color = function (data, palette, width, height) {
                // Convert indexed (palette based) image data to RGB
                // TODO: reduce number of calculations inside loop
                var dest = this._destBuff;
                var w = Math.floor((width + 7) / 8);
                var w1 = Math.floor(width / 8);

                /*for (var y = 0; y < height; y++) {
                    var b, x, dp, sp;
                    var yoffset = y * width;
                    var ybitoffset = y * w;
                    var xoffset, targetbyte;
                    for (x = 0; x < w1; x++) {
                        xoffset = yoffset + x * 8;
                        targetbyte = data[ybitoffset + x];
                        for (b = 7; b >= 0; b--) {
                            dp = (xoffset + 7 - b) * 3;
                            sp = (targetbyte >> b & 1) * 3;
                            dest[dp] = palette[sp];
                            dest[dp + 1] = palette[sp + 1];
                            dest[dp + 2] = palette[sp + 2];
                        }
                    }
                     xoffset = yoffset + x * 8;
                    targetbyte = data[ybitoffset + x];
                    for (b = 7; b >= 8 - width % 8; b--) {
                        dp = (xoffset + 7 - b) * 3;
                        sp = (targetbyte >> b & 1) * 3;
                        dest[dp] = palette[sp];
                        dest[dp + 1] = palette[sp + 1];
                        dest[dp + 2] = palette[sp + 2];
                    }
                }*/

                for (var y = 0; y < height; y++) {
                    var b, x, dp, sp;
                    for (x = 0; x < w1; x++) {
                        for (b = 7; b >= 0; b--) {
                            dp = (y * width + x * 8 + 7 - b) * 4;
                            sp = (data[y * w + x] >> b & 1) * 3;
                            dest[dp] = palette[sp];
                            dest[dp + 1] = palette[sp + 1];
                            dest[dp + 2] = palette[sp + 2];
                            dest[dp + 3] = 255;
                        }
                    }

                    for (b = 7; b >= 8 - width % 8; b--) {
                        dp = (y * width + x * 8 + 7 - b) * 4;
                        sp = (data[y * w + x] >> b & 1) * 3;
                        dest[dp] = palette[sp];
                        dest[dp + 1] = palette[sp + 1];
                        dest[dp + 2] = palette[sp + 2];
                        dest[dp + 3] = 255;
                    }
                }

                return dest;
            }.bind(this);

            var indexedToRGBX = function (data, palette, width, height) {
                // Convert indexed (palette based) image data to RGB
                var dest = this._destBuff;
                var total = width * height * 4;
                for (var i = 0, j = 0; i < total; i += 4, j++) {
                    var sp = data[j] * 3;
                    dest[i] = palette[sp];
                    dest[i + 1] = palette[sp + 1];
                    dest[i + 2] = palette[sp + 2];
                    dest[i + 3] = 255;
                }

                return dest;
            }.bind(this);

            var rQi = this._sock.get_rQi();
            var rQ = this._sock.rQwhole();
            var cmode, data;
            var cl_header, cl_data;

            var handlePalette = function () {
                var numColors = rQ[rQi + 2] + 1;
                var paletteSize = numColors * this._fb_depth;
                this._FBU.bytes += paletteSize;
                if (this._sock.rQwait("TIGHT palette " + cmode, this._FBU.bytes)) {
                    return false;
                }

                var bpp = numColors <= 2 ? 1 : 8;
                var rowSize = Math.floor((this._FBU.width * bpp + 7) / 8);
                var raw = false;
                if (rowSize * this._FBU.height < 12) {
                    raw = true;
                    cl_header = 0;
                    cl_data = rowSize * this._FBU.height;
                    //clength = [0, rowSize * this._FBU.height];
                } else {
                    // begin inline getTightCLength (returning two-item arrays is bad for performance with GC)
                    var cl_offset = rQi + 3 + paletteSize;
                    cl_header = 1;
                    cl_data = 0;
                    cl_data += rQ[cl_offset] & 0x7f;
                    if (rQ[cl_offset] & 0x80) {
                        cl_header++;
                        cl_data += (rQ[cl_offset + 1] & 0x7f) << 7;
                        if (rQ[cl_offset + 1] & 0x80) {
                            cl_header++;
                            cl_data += rQ[cl_offset + 2] << 14;
                        }
                    }
                    // end inline getTightCLength
                }

                this._FBU.bytes += cl_header + cl_data;
                if (this._sock.rQwait("TIGHT " + cmode, this._FBU.bytes)) {
                    return false;
                }

                // Shift ctl, filter id, num colors, palette entries, and clength off
                this._sock.rQskipBytes(3);
                //var palette = this._sock.rQshiftBytes(paletteSize);
                this._sock.rQshiftTo(this._paletteBuff, paletteSize);
                this._sock.rQskipBytes(cl_header);

                if (raw) {
                    data = this._sock.rQshiftBytes(cl_data);
                } else {
                    data = decompress(this._sock.rQshiftBytes(cl_data), rowSize * this._FBU.height);
                }

                // Convert indexed (palette based) image data to RGB
                var rgbx;
                if (numColors == 2) {
                    rgbx = indexedToRGBX2Color(data, this._paletteBuff, this._FBU.width, this._FBU.height);
                    this._display.blitRgbxImage(this._FBU.x, this._FBU.y, this._FBU.width, this._FBU.height, rgbx, 0, false);
                } else {
                    rgbx = indexedToRGBX(data, this._paletteBuff, this._FBU.width, this._FBU.height);
                    this._display.blitRgbxImage(this._FBU.x, this._FBU.y, this._FBU.width, this._FBU.height, rgbx, 0, false);
                }

                return true;
            }.bind(this);

            var handleCopy = function () {
                var raw = false;
                var uncompressedSize = this._FBU.width * this._FBU.height * this._fb_depth;
                if (uncompressedSize < 12) {
                    raw = true;
                    cl_header = 0;
                    cl_data = uncompressedSize;
                } else {
                    // begin inline getTightCLength (returning two-item arrays is for peformance with GC)
                    var cl_offset = rQi + 1;
                    cl_header = 1;
                    cl_data = 0;
                    cl_data += rQ[cl_offset] & 0x7f;
                    if (rQ[cl_offset] & 0x80) {
                        cl_header++;
                        cl_data += (rQ[cl_offset + 1] & 0x7f) << 7;
                        if (rQ[cl_offset + 1] & 0x80) {
                            cl_header++;
                            cl_data += rQ[cl_offset + 2] << 14;
                        }
                    }
                    // end inline getTightCLength
                }
                this._FBU.bytes = 1 + cl_header + cl_data;
                if (this._sock.rQwait("TIGHT " + cmode, this._FBU.bytes)) {
                    return false;
                }

                // Shift ctl, clength off
                this._sock.rQshiftBytes(1 + cl_header);

                if (raw) {
                    data = this._sock.rQshiftBytes(cl_data);
                } else {
                    data = decompress(this._sock.rQshiftBytes(cl_data), uncompressedSize);
                }

                this._display.blitRgbImage(this._FBU.x, this._FBU.y, this._FBU.width, this._FBU.height, data, 0, false);

                return true;
            }.bind(this);

            var ctl = this._sock.rQpeek8();

            // Keep tight reset bits
            resetStreams = ctl & 0xF;

            // Figure out filter
            ctl = ctl >> 4;
            streamId = ctl & 0x3;

            if (ctl === 0x08) cmode = "fill";else if (ctl === 0x09) cmode = "jpeg";else if (ctl === 0x0A) cmode = "png";else if (ctl & 0x04) cmode = "filter";else if (ctl < 0x04) cmode = "copy";else return this._fail("Illegal tight compression received, ctl: " + ctl);

            if (isTightPNG && (cmode === "filter" || cmode === "copy")) {
                return this._fail("filter/copy received in tightPNG mode");
            }

            switch (cmode) {
                // fill use fb_depth because TPIXELs drop the padding byte
                case "fill":
                    // TPIXEL
                    this._FBU.bytes += this._fb_depth;
                    break;
                case "jpeg":
                    // max clength
                    this._FBU.bytes += 3;
                    break;
                case "png":
                    // max clength
                    this._FBU.bytes += 3;
                    break;
                case "filter":
                    // filter id + num colors if palette
                    this._FBU.bytes += 2;
                    break;
                case "copy":
                    break;
            }

            if (this._sock.rQwait("TIGHT " + cmode, this._FBU.bytes)) {
                return false;
            }

            // Determine FBU.bytes
            switch (cmode) {
                case "fill":
                    // skip ctl byte
                    this._display.fillRect(this._FBU.x, this._FBU.y, this._FBU.width, this._FBU.height, [rQ[rQi + 3], rQ[rQi + 2], rQ[rQi + 1]], false);
                    this._sock.rQskipBytes(4);
                    break;
                case "png":
                case "jpeg":
                    // begin inline getTightCLength (returning two-item arrays is for peformance with GC)
                    var cl_offset = rQi + 1;
                    cl_header = 1;
                    cl_data = 0;
                    cl_data += rQ[cl_offset] & 0x7f;
                    if (rQ[cl_offset] & 0x80) {
                        cl_header++;
                        cl_data += (rQ[cl_offset + 1] & 0x7f) << 7;
                        if (rQ[cl_offset + 1] & 0x80) {
                            cl_header++;
                            cl_data += rQ[cl_offset + 2] << 14;
                        }
                    }
                    // end inline getTightCLength
                    this._FBU.bytes = 1 + cl_header + cl_data; // ctl + clength size + jpeg-data
                    if (this._sock.rQwait("TIGHT " + cmode, this._FBU.bytes)) {
                        return false;
                    }

                    // We have everything, render it
                    this._sock.rQskipBytes(1 + cl_header); // shift off clt + compact length
                    var img = new Image();
                    img.src = "data: image/" + cmode + RFB.extract_data_uri(this._sock.rQshiftBytes(cl_data));
                    this._display.renderQ_push({
                        'type': 'img',
                        'img': img,
                        'x': this._FBU.x,
                        'y': this._FBU.y
                    });
                    img = null;
                    break;
                case "filter":
                    var filterId = rQ[rQi + 1];
                    if (filterId === 1) {
                        if (!handlePalette()) {
                            return false;
                        }
                    } else {
                        // Filter 0, Copy could be valid here, but servers don't send it as an explicit filter
                        // Filter 2, Gradient is valid but not use if jpeg is enabled
                        this._fail("Unsupported tight subencoding received, filter: " + filterId);
                    }
                    break;
                case "copy":
                    if (!handleCopy()) {
                        return false;
                    }
                    break;
            }

            this._FBU.bytes = 0;
            this._FBU.rects--;

            return true;
        },

        TIGHT: function () {
            return this._encHandlers.display_tight(false);
        },
        TIGHT_PNG: function () {
            return this._encHandlers.display_tight(true);
        },

        last_rect: function () {
            this._FBU.rects = 0;
            return true;
        },

        handle_FB_resize: function () {
            this._fb_width = this._FBU.width;
            this._fb_height = this._FBU.height;
            this._destBuff = new Uint8Array(this._fb_width * this._fb_height * 4);
            this._display.resize(this._fb_width, this._fb_height);
            this._onFBResize(this, this._fb_width, this._fb_height);
            this._timing.fbu_rt_start = new Date().getTime();
            this._updateContinuousUpdates();

            this._FBU.bytes = 0;
            this._FBU.rects -= 1;
            return true;
        },

        ExtendedDesktopSize: function () {
            this._FBU.bytes = 1;
            if (this._sock.rQwait("ExtendedDesktopSize", this._FBU.bytes)) {
                return false;
            }

            this._supportsSetDesktopSize = true;
            var number_of_screens = this._sock.rQpeek8();

            this._FBU.bytes = 4 + number_of_screens * 16;
            if (this._sock.rQwait("ExtendedDesktopSize", this._FBU.bytes)) {
                return false;
            }

            this._sock.rQskipBytes(1); // number-of-screens
            this._sock.rQskipBytes(3); // padding

            for (var i = 0; i < number_of_screens; i += 1) {
                // Save the id and flags of the first screen
                if (i === 0) {
                    this._screen_id = this._sock.rQshiftBytes(4); // id
                    this._sock.rQskipBytes(2); // x-position
                    this._sock.rQskipBytes(2); // y-position
                    this._sock.rQskipBytes(2); // width
                    this._sock.rQskipBytes(2); // height
                    this._screen_flags = this._sock.rQshiftBytes(4); // flags
                } else {
                    this._sock.rQskipBytes(16);
                }
            }

            /*
             * The x-position indicates the reason for the change:
             *
             *  0 - server resized on its own
             *  1 - this client requested the resize
             *  2 - another client requested the resize
             */

            // We need to handle errors when we requested the resize.
            if (this._FBU.x === 1 && this._FBU.y !== 0) {
                var msg = "";
                // The y-position indicates the status code from the server
                switch (this._FBU.y) {
                    case 1:
                        msg = "Resize is administratively prohibited";
                        break;
                    case 2:
                        msg = "Out of resources";
                        break;
                    case 3:
                        msg = "Invalid screen layout";
                        break;
                    default:
                        msg = "Unknown reason";
                        break;
                }
                _util2.default.Info("Server did not accept the resize request: " + msg);
                return true;
            }

            this._encHandlers.handle_FB_resize();
            return true;
        },

        DesktopSize: function () {
            this._encHandlers.handle_FB_resize();
            return true;
        },

        Cursor: function () {
            _util2.default.Debug(">> set_cursor");
            var x = this._FBU.x; // hotspot-x
            var y = this._FBU.y; // hotspot-y
            var w = this._FBU.width;
            var h = this._FBU.height;

            var pixelslength = w * h * this._fb_Bpp;
            var masklength = Math.floor((w + 7) / 8) * h;

            this._FBU.bytes = pixelslength + masklength;
            if (this._sock.rQwait("cursor encoding", this._FBU.bytes)) {
                return false;
            }

            this._display.changeCursor(this._sock.rQshiftBytes(pixelslength), this._sock.rQshiftBytes(masklength), x, y, w, h);

            this._FBU.bytes = 0;
            this._FBU.rects--;

            _util2.default.Debug("<< set_cursor");
            return true;
        },

        QEMUExtendedKeyEvent: function () {
            this._FBU.rects--;

            var keyboardEvent = document.createEvent("keyboardEvent");
            if (keyboardEvent.code !== undefined) {
                this._qemuExtKeyEventSupported = true;
                this._keyboard.setQEMUVNCKeyboardHandler();
            }
        },

        JPEG_quality_lo: function () {
            _util2.default.Error("Server sent jpeg_quality pseudo-encoding");
        },

        compress_lo: function () {
            _util2.default.Error("Server sent compress level pseudo-encoding");
        }
    };
})();
module.exports = exports["default"];
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInJmYi5qcyJdLCJuYW1lcyI6WyJSRkIiLCJkZWZhdWx0cyIsIl9yZmJfaG9zdCIsIl9yZmJfcG9ydCIsIl9yZmJfcGFzc3dvcmQiLCJfcmZiX3BhdGgiLCJfcmZiX3N0YXRlIiwiX3JmYl92ZXJzaW9uIiwiX3JmYl9tYXhfdmVyc2lvbiIsIl9yZmJfYXV0aF9zY2hlbWUiLCJfcmZiX3RpZ2h0dm5jIiwiX3JmYl94dnBfdmVyIiwiX2VuY29kaW5ncyIsIl9lbmNIYW5kbGVycyIsIl9lbmNOYW1lcyIsIl9lbmNTdGF0cyIsIl9zb2NrIiwiX2Rpc3BsYXkiLCJfa2V5Ym9hcmQiLCJfbW91c2UiLCJfZGlzY29ublRpbWVyIiwiX21zZ1RpbWVyIiwiX3N1cHBvcnRzRmVuY2UiLCJfc3VwcG9ydHNDb250aW51b3VzVXBkYXRlcyIsIl9lbmFibGVkQ29udGludW91c1VwZGF0ZXMiLCJfRkJVIiwicmVjdHMiLCJzdWJyZWN0cyIsImxpbmVzIiwidGlsZXMiLCJieXRlcyIsIngiLCJ5Iiwid2lkdGgiLCJoZWlnaHQiLCJlbmNvZGluZyIsInN1YmVuY29kaW5nIiwiYmFja2dyb3VuZCIsInpsaWIiLCJfZmJfQnBwIiwiX2ZiX2RlcHRoIiwiX2ZiX3dpZHRoIiwiX2ZiX2hlaWdodCIsIl9mYl9uYW1lIiwiX2Rlc3RCdWZmIiwiX3BhbGV0dGVCdWZmIiwiVWludDhBcnJheSIsIl9ycmVfY2h1bmtfc3oiLCJfdGltaW5nIiwibGFzdF9mYnUiLCJmYnVfdG90YWwiLCJmYnVfdG90YWxfY250IiwiZnVsbF9mYnVfdG90YWwiLCJmdWxsX2ZidV9jbnQiLCJmYnVfcnRfc3RhcnQiLCJmYnVfcnRfdG90YWwiLCJmYnVfcnRfY250IiwicGl4ZWxzIiwiX3N1cHBvcnRzU2V0RGVza3RvcFNpemUiLCJfc2NyZWVuX2lkIiwiX3NjcmVlbl9mbGFncyIsIl9tb3VzZV9idXR0b25NYXNrIiwiX21vdXNlX2FyciIsIl92aWV3cG9ydERyYWdnaW5nIiwiX3ZpZXdwb3J0RHJhZ1BvcyIsIl92aWV3cG9ydEhhc01vdmVkIiwiX3FlbXVFeHRLZXlFdmVudFN1cHBvcnRlZCIsInNldF9kZWZhdWx0cyIsImRvY3VtZW50IiwiRGVidWciLCJPYmplY3QiLCJrZXlzIiwiZW5jb2RpbmdIYW5kbGVycyIsImZvckVhY2giLCJlbmNOYW1lIiwiYmluZCIsImkiLCJsZW5ndGgiLCJ0YXJnZXQiLCJfdGFyZ2V0IiwiZXhjIiwiRXJyb3IiLCJfZm9jdXNDb250YWluZXIiLCJvbktleVByZXNzIiwiX2hhbmRsZUtleVByZXNzIiwib25Nb3VzZUJ1dHRvbiIsIl9oYW5kbGVNb3VzZUJ1dHRvbiIsIm9uTW91c2VNb3ZlIiwiX2hhbmRsZU1vdXNlTW92ZSIsIm5vdGlmeSIsInN5bmMiLCJvbiIsIl9oYW5kbGVfbWVzc2FnZSIsIl91cGRhdGVTdGF0ZSIsIl9mYWlsIiwiZSIsIldhcm4iLCJtc2ciLCJjb2RlIiwicmVhc29uIiwib2ZmIiwiX2luaXRfdmFycyIsInJtb2RlIiwiZ2V0X3JlbmRlcl9tb2RlIiwiSW5mbyIsInByb3RvdHlwZSIsImNvbm5lY3QiLCJob3N0IiwicG9ydCIsInBhc3N3b3JkIiwicGF0aCIsInVuZGVmaW5lZCIsImRpc2Nvbm5lY3QiLCJzZW5kUGFzc3dvcmQiLCJwYXNzd2QiLCJzZXRUaW1lb3V0IiwiX2luaXRfbXNnIiwic2VuZEN0cmxBbHREZWwiLCJfdmlld19vbmx5IiwibWVzc2FnZXMiLCJrZXlFdmVudCIsIlhLX0NvbnRyb2xfTCIsIlhLX0FsdF9MIiwiWEtfRGVsZXRlIiwieHZwT3AiLCJ2ZXIiLCJvcCIsInNlbmRfc3RyaW5nIiwiU3RyaW5nIiwiZnJvbUNoYXJDb2RlIiwieHZwU2h1dGRvd24iLCJ4dnBSZWJvb3QiLCJ4dnBSZXNldCIsInNlbmRLZXkiLCJkb3duIiwiY2xpcGJvYXJkUGFzdGVGcm9tIiwidGV4dCIsImNsaWVudEN1dFRleHQiLCJyZXF1ZXN0RGVza3RvcFNpemUiLCJzZXREZXNrdG9wU2l6ZSIsImZsdXNoIiwiX2Nvbm5lY3QiLCJ1cmkiLCJVc2luZ1NvY2tldElPIiwiX2VuY3J5cHQiLCJvcGVuIiwiX3dzUHJvdG9jb2xzIiwiemxpYnMiLCJJbmZsYXRlIiwiX3ByaW50X3N0YXRzIiwicyIsIl9jbGVhbnVwU29ja2V0Iiwic3RhdGUiLCJjbGVhckludGVydmFsIiwiZ2V0X2NvbnRleHQiLCJ1bmdyYWIiLCJkZWZhdWx0Q3Vyc29yIiwiZ2V0X2xvZ2dpbmciLCJjbGVhciIsImNsb3NlIiwic3RhdHVzTXNnIiwib2xkc3RhdGUiLCJjbXNnIiwiZnVsbG1zZyIsImNsZWFyVGltZW91dCIsIl9kaXNjb25uZWN0VGltZW91dCIsIl9vblVwZGF0ZVN0YXRlIiwiclFsZW4iLCJfbm9ybWFsX21zZyIsImtleWV2ZW50IiwidHlwZSIsInNjYW5jb2RlIiwia2V5c3ltIiwiUUVNVUV4dGVuZGVkS2V5RXZlbnQiLCJibWFzayIsIl92aWV3cG9ydERyYWciLCJwb2ludGVyRXZlbnQiLCJhYnNYIiwiYWJzWSIsImRlbHRhWCIsImRlbHRhWSIsImRyYWdUaHJlc2hvbGQiLCJ3aW5kb3ciLCJkZXZpY2VQaXhlbFJhdGlvIiwiTWF0aCIsImFicyIsInZpZXdwb3J0Q2hhbmdlUG9zIiwiX25lZ290aWF0ZV9wcm90b2NvbF92ZXJzaW9uIiwic3ZlcnNpb24iLCJyUXNoaWZ0U3RyIiwic3Vic3RyIiwiaXNfcmVwZWF0ZXIiLCJyZXBlYXRlcklEIiwiX3JlcGVhdGVySUQiLCJjdmVyc2lvbiIsInBhcnNlSW50IiwiX25lZ290aWF0ZV9zZWN1cml0eSIsIm51bV90eXBlcyIsInJRc2hpZnQ4IiwiclF3YWl0Iiwic3RybGVuIiwiclFzaGlmdDMyIiwidHlwZXMiLCJyUXNoaWZ0Qnl0ZXMiLCJzZW5kIiwiX25lZ290aWF0ZV94dnBfYXV0aCIsInh2cF9zZXAiLCJfeHZwX3Bhc3N3b3JkX3NlcCIsInh2cF9hdXRoIiwic3BsaXQiLCJfb25QYXNzd29yZFJlcXVpcmVkIiwieHZwX2F1dGhfc3RyIiwic2xpY2UiLCJqb2luIiwiX25lZ290aWF0ZV9hdXRoZW50aWNhdGlvbiIsIl9uZWdvdGlhdGVfc3RkX3ZuY19hdXRoIiwiY2hhbGxlbmdlIiwiQXJyYXkiLCJjYWxsIiwicmVzcG9uc2UiLCJnZW5ERVMiLCJfbmVnb3RpYXRlX3RpZ2h0X3R1bm5lbHMiLCJudW1UdW5uZWxzIiwiY2xpZW50U3VwcG9ydGVkVHVubmVsVHlwZXMiLCJ2ZW5kb3IiLCJzaWduYXR1cmUiLCJzZXJ2ZXJTdXBwb3J0ZWRUdW5uZWxUeXBlcyIsImNhcF9jb2RlIiwiY2FwX3ZlbmRvciIsImNhcF9zaWduYXR1cmUiLCJfbmVnb3RpYXRlX3RpZ2h0X2F1dGgiLCJzdWJBdXRoQ291bnQiLCJjbGllbnRTdXBwb3J0ZWRUeXBlcyIsInNlcnZlclN1cHBvcnRlZFR5cGVzIiwiY2FwTnVtIiwiY2FwYWJpbGl0aWVzIiwicHVzaCIsImF1dGhUeXBlIiwiaW5kZXhPZiIsIl9oYW5kbGVfc2VjdXJpdHlfcmVzdWx0IiwiX25lZ290aWF0ZV9zZXJ2ZXJfaW5pdCIsInJRc2hpZnQxNiIsImJwcCIsImRlcHRoIiwiYmlnX2VuZGlhbiIsInRydWVfY29sb3IiLCJyZWRfbWF4IiwiZ3JlZW5fbWF4IiwiYmx1ZV9tYXgiLCJyZWRfc2hpZnQiLCJncmVlbl9zaGlmdCIsImJsdWVfc2hpZnQiLCJyUXNraXBCeXRlcyIsIm5hbWVfbGVuZ3RoIiwiZGVjb2RlVVRGOCIsIm51bVNlcnZlck1lc3NhZ2VzIiwibnVtQ2xpZW50TWVzc2FnZXMiLCJudW1FbmNvZGluZ3MiLCJ0b3RhbE1lc3NhZ2VzTGVuZ3RoIiwiX29uRGVza3RvcE5hbWUiLCJfdHJ1ZV9jb2xvciIsInNldF90cnVlX2NvbG9yIiwicmVzaXplIiwiX29uRkJSZXNpemUiLCJncmFiIiwicGl4ZWxGb3JtYXQiLCJjbGllbnRFbmNvZGluZ3MiLCJfbG9jYWxfY3Vyc29yIiwiZmJVcGRhdGVSZXF1ZXN0cyIsImdldENsZWFuRGlydHlSZXNldCIsIkRhdGUiLCJnZXRUaW1lIiwiX3NoYXJlZCIsIl9oYW5kbGVfc2V0X2NvbG91cl9tYXBfbXNnIiwiclFza2lwOCIsImZpcnN0X2NvbG91ciIsIm51bV9jb2xvdXJzIiwiYyIsInJlZCIsImdyZWVuIiwiYmx1ZSIsInNldF9jb2xvdXJNYXAiLCJnZXRfY29sb3VyTWFwIiwiX2hhbmRsZV9zZXJ2ZXJfY3V0X3RleHQiLCJfb25DbGlwYm9hcmQiLCJfaGFuZGxlX3NlcnZlcl9mZW5jZV9tc2ciLCJmbGFncyIsInBheWxvYWQiLCJjbGllbnRGZW5jZSIsIl9oYW5kbGVfeHZwX21zZyIsInh2cF92ZXIiLCJ4dnBfbXNnIiwiX29uWHZwSW5pdCIsIm1zZ190eXBlIiwicmV0IiwiX2ZyYW1lYnVmZmVyVXBkYXRlIiwiX29uQmVsbCIsImZpcnN0IiwiX3VwZGF0ZUNvbnRpbnVvdXNVcGRhdGVzIiwiclFzbGljZSIsIm5vdyIsImN1cl9mYnUiLCJoZHIiLCJfb25GQlVSZWNlaXZlIiwiZmJ1X3J0X2RpZmYiLCJfb25GQlVDb21wbGV0ZSIsImVuYWJsZUNvbnRpbnVvdXNVcGRhdGVzIiwibWFrZV9wcm9wZXJ0aWVzIiwic2V0X2xvY2FsX2N1cnNvciIsImN1cnNvciIsImRpc2FibGVMb2NhbEN1cnNvciIsImdldF9jdXJzb3JfdXJpIiwiZ2V0X2Rpc3BsYXkiLCJnZXRfa2V5Ym9hcmQiLCJnZXRfbW91c2UiLCJzb2NrIiwiYnVmZiIsIl9zUSIsIm9mZnNldCIsIl9zUWxlbiIsImtleWNvZGUiLCJnZXRSRkJrZXljb2RlIiwieHRfc2NhbmNvZGUiLCJ1cHBlckJ5dGUiLCJsb3dlckJ5dGUiLCJSRkJrZXljb2RlIiwibWFzayIsIm4iLCJjaGFyQ29kZUF0IiwiaWQiLCJlbmFibGUiLCJlbmNvZGluZ3MiLCJsb2NhbF9jdXJzb3IiLCJqIiwiY250IiwiZW5jIiwib25seU5vbkluYyIsImNsZWFuRGlydHkiLCJmYl93aWR0aCIsImZiX2hlaWdodCIsIm9mZnNldEluY3JlbWVudCIsImNiIiwiY2xlYW5Cb3giLCJ3IiwiaCIsImZiVXBkYXRlUmVxdWVzdCIsImRpcnR5Qm94ZXMiLCJkYiIsImluY3JlbWVudGFsIiwiZW5jcnlwdCIsImV4dHJhY3RfZGF0YV91cmkiLCJhcnIiLCJlbmNvZGUiLCJSQVciLCJjdXJfeSIsImN1cnJfaGVpZ2h0IiwibWluIiwiZmxvb3IiLCJibGl0SW1hZ2UiLCJnZXRfclEiLCJnZXRfclFpIiwiQ09QWVJFQ1QiLCJjb3B5SW1hZ2UiLCJSUkUiLCJjb2xvciIsImZpbGxSZWN0IiwiY2h1bmsiLCJIRVhUSUxFIiwiclEiLCJyUWkiLCJ0aWxlc194IiwiY2VpbCIsInRpbGVzX3kiLCJ0b3RhbF90aWxlcyIsImN1cnJfdGlsZSIsInRpbGVfeCIsInRpbGVfeSIsImxhc3RzdWJlbmNvZGluZyIsImZvcmVncm91bmQiLCJzdGFydFRpbGUiLCJ4eSIsInN4Iiwic3kiLCJ3aCIsInN3Iiwic2giLCJzdWJUaWxlIiwiZmluaXNoVGlsZSIsInNldF9yUWkiLCJnZXRUaWdodENMZW5ndGgiLCJoZWFkZXIiLCJkYXRhIiwiZGlzcGxheV90aWdodCIsImlzVGlnaHRQTkciLCJjaGVja3N1bSIsInN1bSIsInJlc2V0U3RyZWFtcyIsInN0cmVhbUlkIiwiZGVjb21wcmVzcyIsImV4cGVjdGVkIiwicmVzZXQiLCJ1bmNvbXByZXNzZWQiLCJpbmZsYXRlIiwiaW5kZXhlZFRvUkdCWDJDb2xvciIsInBhbGV0dGUiLCJkZXN0IiwidzEiLCJiIiwiZHAiLCJzcCIsImluZGV4ZWRUb1JHQlgiLCJ0b3RhbCIsInJRd2hvbGUiLCJjbW9kZSIsImNsX2hlYWRlciIsImNsX2RhdGEiLCJoYW5kbGVQYWxldHRlIiwibnVtQ29sb3JzIiwicGFsZXR0ZVNpemUiLCJyb3dTaXplIiwicmF3IiwiY2xfb2Zmc2V0IiwiclFzaGlmdFRvIiwicmdieCIsImJsaXRSZ2J4SW1hZ2UiLCJoYW5kbGVDb3B5IiwidW5jb21wcmVzc2VkU2l6ZSIsImJsaXRSZ2JJbWFnZSIsImN0bCIsInJRcGVlazgiLCJpbWciLCJJbWFnZSIsInNyYyIsInJlbmRlclFfcHVzaCIsImZpbHRlcklkIiwiVElHSFQiLCJUSUdIVF9QTkciLCJsYXN0X3JlY3QiLCJoYW5kbGVfRkJfcmVzaXplIiwiRXh0ZW5kZWREZXNrdG9wU2l6ZSIsIm51bWJlcl9vZl9zY3JlZW5zIiwiRGVza3RvcFNpemUiLCJDdXJzb3IiLCJwaXhlbHNsZW5ndGgiLCJtYXNrbGVuZ3RoIiwiY2hhbmdlQ3Vyc29yIiwia2V5Ym9hcmRFdmVudCIsImNyZWF0ZUV2ZW50Iiwic2V0UUVNVVZOQ0tleWJvYXJkSGFuZGxlciIsIkpQRUdfcXVhbGl0eV9sbyIsImNvbXByZXNzX2xvIl0sIm1hcHBpbmdzIjoiOzs7OztrQkF5QndCQSxHOztBQWJ4Qjs7OztBQUNBOzs7O0FBQ0E7O0FBQ0E7Ozs7QUFDQTs7OztBQUNBOzs7O0FBQ0E7Ozs7QUFDQTs7OztBQUNBOzs7Ozs7QUFFQTtBQUNBOztBQUVlLFNBQVNBLEdBQVQsQ0FBYUMsUUFBYixFQUF1QjtBQUNsQzs7QUFDQSxRQUFJLENBQUNBLFFBQUwsRUFBZTtBQUNYQSxtQkFBVyxFQUFYO0FBQ0g7O0FBRUQsU0FBS0MsU0FBTCxHQUFpQixFQUFqQjtBQUNBLFNBQUtDLFNBQUwsR0FBaUIsSUFBakI7QUFDQSxTQUFLQyxhQUFMLEdBQXFCLEVBQXJCO0FBQ0EsU0FBS0MsU0FBTCxHQUFpQixFQUFqQjs7QUFFQSxTQUFLQyxVQUFMLEdBQWtCLGNBQWxCO0FBQ0EsU0FBS0MsWUFBTCxHQUFvQixDQUFwQjtBQUNBLFNBQUtDLGdCQUFMLEdBQXdCLEdBQXhCO0FBQ0EsU0FBS0MsZ0JBQUwsR0FBd0IsRUFBeEI7O0FBRUEsU0FBS0MsYUFBTCxHQUFxQixLQUFyQjtBQUNBLFNBQUtDLFlBQUwsR0FBb0IsQ0FBcEI7O0FBRUE7QUFDQSxTQUFLQyxVQUFMLEdBQWtCLENBQ2QsQ0FBQyxVQUFELEVBQXlCLElBQXpCLENBRGMsRUFFZCxDQUFDLE9BQUQsRUFBeUIsSUFBekIsQ0FGYyxFQUdkLENBQUMsV0FBRCxFQUF5QixDQUFDLEdBQTFCLENBSGMsRUFJZCxDQUFDLFNBQUQsRUFBeUIsSUFBekIsQ0FKYyxFQUtkLENBQUMsS0FBRCxFQUF5QixJQUF6QixDQUxjLEVBTWQsQ0FBQyxLQUFELEVBQXlCLElBQXpCLENBTmM7O0FBUWQ7O0FBRUE7QUFDQSxLQUFDLGtCQUFELEVBQTBCLENBQUMsRUFBM0IsQ0FYYztBQVlkO0FBQ0E7QUFDQSxLQUFDLGFBQUQsRUFBeUIsQ0FBQyxHQUExQixDQWRjLEVBZ0JkLENBQUMsYUFBRCxFQUF5QixDQUFDLEdBQTFCLENBaEJjLEVBaUJkLENBQUMsV0FBRCxFQUF5QixDQUFDLEdBQTFCLENBakJjLEVBa0JkLENBQUMsUUFBRCxFQUF5QixDQUFDLEdBQTFCLENBbEJjLEVBbUJkLENBQUMsc0JBQUQsRUFBeUIsQ0FBQyxHQUExQixDQW5CYyxFQW9CZCxDQUFDLHFCQUFELEVBQXlCLENBQUMsR0FBMUIsQ0FwQmMsRUFxQmQsQ0FBQyxLQUFELEVBQXlCLENBQUMsR0FBMUIsQ0FyQmMsRUFzQmQsQ0FBQyxPQUFELEVBQXlCLENBQUMsR0FBMUIsQ0F0QmMsRUF1QmQsQ0FBQyxtQkFBRCxFQUF5QixDQUFDLEdBQTFCLENBdkJjLENBQWxCOztBQTBCQSxTQUFLQyxZQUFMLEdBQW9CLEVBQXBCO0FBQ0EsU0FBS0MsU0FBTCxHQUFpQixFQUFqQjtBQUNBLFNBQUtDLFNBQUwsR0FBaUIsRUFBakI7O0FBRUEsU0FBS0MsS0FBTCxHQUFhLElBQWIsQ0FsRGtDLENBa0RGO0FBQ2hDLFNBQUtDLFFBQUwsR0FBZ0IsSUFBaEIsQ0FuRGtDLENBbURGO0FBQ2hDLFNBQUtDLFNBQUwsR0FBaUIsSUFBakIsQ0FwRGtDLENBb0RGO0FBQ2hDLFNBQUtDLE1BQUwsR0FBYyxJQUFkLENBckRrQyxDQXFERjtBQUNoQyxTQUFLQyxhQUFMLEdBQXFCLElBQXJCLENBdERrQyxDQXNERjtBQUNoQyxTQUFLQyxTQUFMLEdBQWlCLElBQWpCLENBdkRrQyxDQXVERjs7QUFFaEMsU0FBS0MsY0FBTCxHQUFzQixLQUF0Qjs7QUFFQSxTQUFLQywwQkFBTCxHQUFrQyxLQUFsQztBQUNBLFNBQUtDLHlCQUFMLEdBQWlDLEtBQWpDOztBQUVBO0FBQ0EsU0FBS0MsSUFBTCxHQUFZO0FBQ1JDLGVBQU8sQ0FEQztBQUVSQyxrQkFBVSxDQUZGLEVBRWdCO0FBQ3hCQyxlQUFPLENBSEMsRUFHZ0I7QUFDeEJDLGVBQU8sQ0FKQyxFQUlnQjtBQUN4QkMsZUFBTyxDQUxDO0FBTVJDLFdBQUcsQ0FOSztBQU9SQyxXQUFHLENBUEs7QUFRUkMsZUFBTyxDQVJDO0FBU1JDLGdCQUFRLENBVEE7QUFVUkMsa0JBQVUsQ0FWRjtBQVdSQyxxQkFBYSxDQUFDLENBWE47QUFZUkMsb0JBQVksSUFaSjtBQWFSQyxjQUFNLEVBYkUsQ0FhZ0I7QUFiaEIsS0FBWjs7QUFnQkEsU0FBS0MsT0FBTCxHQUFlLENBQWY7QUFDQSxTQUFLQyxTQUFMLEdBQWlCLENBQWpCO0FBQ0EsU0FBS0MsU0FBTCxHQUFpQixDQUFqQjtBQUNBLFNBQUtDLFVBQUwsR0FBa0IsQ0FBbEI7QUFDQSxTQUFLQyxRQUFMLEdBQWdCLEVBQWhCOztBQUVBLFNBQUtDLFNBQUwsR0FBaUIsSUFBakI7QUFDQSxTQUFLQyxZQUFMLEdBQW9CLElBQUlDLFVBQUosQ0FBZSxJQUFmLENBQXBCLENBdEZrQyxDQXNGUzs7QUFFM0MsU0FBS0MsYUFBTCxHQUFxQixHQUFyQjs7QUFFQSxTQUFLQyxPQUFMLEdBQWU7QUFDWEMsa0JBQVUsQ0FEQztBQUVYQyxtQkFBVyxDQUZBO0FBR1hDLHVCQUFlLENBSEo7QUFJWEMsd0JBQWdCLENBSkw7QUFLWEMsc0JBQWMsQ0FMSDs7QUFPWEMsc0JBQWMsQ0FQSDtBQVFYQyxzQkFBYyxDQVJIO0FBU1hDLG9CQUFZLENBVEQ7QUFVWEMsZ0JBQVE7QUFWRyxLQUFmOztBQWFBLFNBQUtDLHVCQUFMLEdBQStCLEtBQS9CO0FBQ0EsU0FBS0MsVUFBTCxHQUFrQixDQUFsQjtBQUNBLFNBQUtDLGFBQUwsR0FBcUIsQ0FBckI7O0FBRUE7QUFDQSxTQUFLQyxpQkFBTCxHQUF5QixDQUF6QjtBQUNBLFNBQUtDLFVBQUwsR0FBa0IsRUFBbEI7QUFDQSxTQUFLQyxpQkFBTCxHQUF5QixLQUF6QjtBQUNBLFNBQUtDLGdCQUFMLEdBQXdCLEVBQXhCO0FBQ0EsU0FBS0MsaUJBQUwsR0FBeUIsS0FBekI7O0FBRUE7QUFDQSxTQUFLQyx5QkFBTCxHQUFpQyxLQUFqQzs7QUFFQTtBQUNBLG1CQUFLQyxZQUFMLENBQWtCLElBQWxCLEVBQXdCbEUsUUFBeEIsRUFBa0M7QUFDOUIsa0JBQVUsTUFEb0IsRUFDVTtBQUN4QywwQkFBa0JtRSxRQUZZLEVBRVU7QUFDeEMsbUJBQVcsS0FIbUIsRUFHVTtBQUN4QyxzQkFBYyxJQUpnQixFQUlVO0FBQ3hDLHdCQUFnQixLQUxjLEVBS1U7QUFDeEMsa0JBQVUsSUFOb0IsRUFNVTtBQUN4QyxxQkFBYSxLQVBpQixFQU9VO0FBQ3hDLDRCQUFvQixHQVJVLEVBUVU7QUFDeEMsNkJBQXFCLENBVFMsRUFTVTtBQUN4Qyx1QkFBZSxDQUFDLFFBQUQsQ0FWZSxFQVVVO0FBQ3hDLHNCQUFjLEVBWGdCLEVBV1U7QUFDeEMsd0JBQWdCLEtBWmMsRUFZVTs7QUFFeEM7QUFDQSx5QkFBaUIsWUFBWSxDQUFHLENBZkYsRUFlVTtBQUN4Qyw4QkFBc0IsWUFBWSxDQUFHLENBaEJQLEVBZ0JVO0FBQ3hDLHVCQUFlLFlBQVksQ0FBRyxDQWpCQSxFQWlCVTtBQUN4QyxrQkFBVSxZQUFZLENBQUcsQ0FsQkssRUFrQlU7QUFDeEMsd0JBQWdCLFlBQVksQ0FBRyxDQW5CRCxFQW1CVTtBQUN4Qyx5QkFBaUIsWUFBWSxDQUFHLENBcEJGLEVBb0JVO0FBQ3hDLHNCQUFjLFlBQVksQ0FBRyxDQXJCQyxFQXFCVTtBQUN4Qyx5QkFBaUIsWUFBWSxDQUFHLENBdEJGLEVBc0JVO0FBQ3hDLHFCQUFhLFlBQVksQ0FBRyxDQXZCRSxDQXVCVTtBQXZCVixLQUFsQzs7QUEwQkE7QUFDQSxtQkFBS0MsS0FBTCxDQUFXLG9CQUFYOztBQUVBO0FBQ0FDLFdBQU9DLElBQVAsQ0FBWXZFLElBQUl3RSxnQkFBaEIsRUFBa0NDLE9BQWxDLENBQTBDLFVBQVVDLE9BQVYsRUFBbUI7QUFDekQsYUFBSzdELFlBQUwsQ0FBa0I2RCxPQUFsQixJQUE2QjFFLElBQUl3RSxnQkFBSixDQUFxQkUsT0FBckIsRUFBOEJDLElBQTlCLENBQW1DLElBQW5DLENBQTdCO0FBQ0gsS0FGeUMsQ0FFeENBLElBRndDLENBRW5DLElBRm1DLENBQTFDOztBQUlBO0FBQ0EsU0FBSyxJQUFJQyxJQUFJLENBQWIsRUFBZ0JBLElBQUksS0FBS2hFLFVBQUwsQ0FBZ0JpRSxNQUFwQyxFQUE0Q0QsR0FBNUMsRUFBaUQ7QUFDN0MsYUFBSy9ELFlBQUwsQ0FBa0IsS0FBS0QsVUFBTCxDQUFnQmdFLENBQWhCLEVBQW1CLENBQW5CLENBQWxCLElBQTJDLEtBQUsvRCxZQUFMLENBQWtCLEtBQUtELFVBQUwsQ0FBZ0JnRSxDQUFoQixFQUFtQixDQUFuQixDQUFsQixDQUEzQztBQUNBLGFBQUs5RCxTQUFMLENBQWUsS0FBS0YsVUFBTCxDQUFnQmdFLENBQWhCLEVBQW1CLENBQW5CLENBQWYsSUFBd0MsS0FBS2hFLFVBQUwsQ0FBZ0JnRSxDQUFoQixFQUFtQixDQUFuQixDQUF4QztBQUNBLGFBQUs3RCxTQUFMLENBQWUsS0FBS0gsVUFBTCxDQUFnQmdFLENBQWhCLEVBQW1CLENBQW5CLENBQWYsSUFBd0MsQ0FBQyxDQUFELEVBQUksQ0FBSixDQUF4QztBQUNIOztBQUVEO0FBQ0E7QUFDQSxRQUFJO0FBQ0EsYUFBSzNELFFBQUwsR0FBZ0Isc0JBQVksRUFBQzZELFFBQVEsS0FBS0MsT0FBZCxFQUFaLENBQWhCO0FBQ0gsS0FGRCxDQUVFLE9BQU9DLEdBQVAsRUFBWTtBQUNWLHVCQUFLQyxLQUFMLENBQVcsd0JBQXdCRCxHQUFuQztBQUNBLGNBQU1BLEdBQU47QUFDSDs7QUFFRCxTQUFLOUQsU0FBTCxHQUFpQixzQkFBYSxFQUFDNEQsUUFBUSxLQUFLSSxlQUFkO0FBQ0NDLG9CQUFZLEtBQUtDLGVBQUwsQ0FBcUJULElBQXJCLENBQTBCLElBQTFCLENBRGIsRUFBYixDQUFqQjs7QUFHQSxTQUFLeEQsTUFBTCxHQUFjLG1CQUFVLEVBQUMyRCxRQUFRLEtBQUtDLE9BQWQ7QUFDQ00sdUJBQWUsS0FBS0Msa0JBQUwsQ0FBd0JYLElBQXhCLENBQTZCLElBQTdCLENBRGhCO0FBRUNZLHFCQUFhLEtBQUtDLGdCQUFMLENBQXNCYixJQUF0QixDQUEyQixJQUEzQixDQUZkO0FBR0NjLGdCQUFRLEtBQUt2RSxTQUFMLENBQWV3RSxJQUFmLENBQW9CZixJQUFwQixDQUF5QixLQUFLekQsU0FBOUIsQ0FIVCxFQUFWLENBQWQ7O0FBS0EsU0FBS0YsS0FBTCxHQUFhLHVCQUFiO0FBQ0EsU0FBS0EsS0FBTCxDQUFXMkUsRUFBWCxDQUFjLFNBQWQsRUFBeUIsS0FBS0MsZUFBTCxDQUFxQmpCLElBQXJCLENBQTBCLElBQTFCLENBQXpCO0FBQ0EsU0FBSzNELEtBQUwsQ0FBVzJFLEVBQVgsQ0FBYyxNQUFkLEVBQXNCLFlBQVk7QUFDOUIsWUFBSSxLQUFLckYsVUFBTCxLQUFvQixTQUF4QixFQUFtQztBQUMvQixpQkFBS3VGLFlBQUwsQ0FBa0IsaUJBQWxCLEVBQXFDLHdCQUFyQztBQUNILFNBRkQsTUFFTztBQUNILGlCQUFLQyxLQUFMLENBQVcscUNBQVg7QUFDSDtBQUNKLEtBTnFCLENBTXBCbkIsSUFOb0IsQ0FNZixJQU5lLENBQXRCO0FBT0EsU0FBSzNELEtBQUwsQ0FBVzJFLEVBQVgsQ0FBYyxPQUFkLEVBQXVCLFVBQVVJLENBQVYsRUFBYTtBQUNoQyx1QkFBS0MsSUFBTCxDQUFVLDBCQUFWO0FBQ0EsWUFBSUMsTUFBTSxFQUFWO0FBQ0EsWUFBSUYsRUFBRUcsSUFBTixFQUFZO0FBQ1JELGtCQUFNLGFBQWFGLEVBQUVHLElBQXJCO0FBQ0EsZ0JBQUlILEVBQUVJLE1BQU4sRUFBYztBQUNWRix1QkFBTyxlQUFlRixFQUFFSSxNQUF4QjtBQUNIO0FBQ0RGLG1CQUFPLEdBQVA7QUFDSDtBQUNELFlBQUksS0FBSzNGLFVBQUwsS0FBb0IsWUFBeEIsRUFBc0M7QUFDbEMsaUJBQUt1RixZQUFMLENBQWtCLGNBQWxCLEVBQWtDLHFCQUFxQkksR0FBdkQ7QUFDSCxTQUZELE1BRU8sSUFBSSxLQUFLM0YsVUFBTCxLQUFvQixpQkFBeEIsRUFBMkM7QUFDOUMsaUJBQUt3RixLQUFMLENBQVcsZ0NBQWdDRyxHQUEzQztBQUNILFNBRk0sTUFFQSxJQUFJLEtBQUszRixVQUFMLElBQW1CLEVBQUMsVUFBVSxDQUFYLEVBQWMsZ0JBQWdCLENBQTlCLEVBQXZCLEVBQXlEO0FBQzVELDJCQUFLMkUsS0FBTCxDQUFXLHdDQUF3Q2dCLEdBQW5EO0FBQ0gsU0FGTSxNQUVBO0FBQ0gsaUJBQUtILEtBQUwsQ0FBVyx3QkFBd0JHLEdBQW5DO0FBQ0g7QUFDRCxhQUFLakYsS0FBTCxDQUFXb0YsR0FBWCxDQUFlLE9BQWY7QUFDSCxLQXBCc0IsQ0FvQnJCekIsSUFwQnFCLENBb0JoQixJQXBCZ0IsQ0FBdkI7QUFxQkEsU0FBSzNELEtBQUwsQ0FBVzJFLEVBQVgsQ0FBYyxPQUFkLEVBQXVCLFVBQVVJLENBQVYsRUFBYTtBQUNoQyx1QkFBS0MsSUFBTCxDQUFVLDBCQUFWO0FBQ0gsS0FGRDs7QUFJQSxTQUFLSyxVQUFMOztBQUVBLFFBQUlDLFFBQVEsS0FBS3JGLFFBQUwsQ0FBY3NGLGVBQWQsRUFBWjtBQUNBLG1CQUFLQyxJQUFMLENBQVUseUJBQVY7QUFDQSxTQUFLWCxZQUFMLENBQWtCLFFBQWxCLEVBQTRCLHFDQUFxQ1MsS0FBakU7O0FBRUEsbUJBQUtqQyxLQUFMLENBQVcsb0JBQVg7QUFDSCxDLENBbFBEOzs7Ozs7Ozs7Ozs7QUFrUEM7O0FBRUQsQ0FBQyxZQUFXO0FBQ1JyRSxRQUFJeUcsU0FBSixHQUFnQjtBQUNaO0FBQ0FDLGlCQUFTLFVBQVVDLElBQVYsRUFBZ0JDLElBQWhCLEVBQXNCQyxRQUF0QixFQUFnQ0MsSUFBaEMsRUFBc0M7QUFDM0MsaUJBQUs1RyxTQUFMLEdBQWlCeUcsSUFBakI7QUFDQSxpQkFBS3hHLFNBQUwsR0FBaUJ5RyxJQUFqQjtBQUNBLGlCQUFLeEcsYUFBTCxHQUFzQnlHLGFBQWFFLFNBQWQsR0FBMkJGLFFBQTNCLEdBQXNDLEVBQTNEO0FBQ0EsaUJBQUt4RyxTQUFMLEdBQWtCeUcsU0FBU0MsU0FBVixHQUF1QkQsSUFBdkIsR0FBOEIsRUFBL0M7O0FBRUEsZ0JBQUksQ0FBQyxLQUFLNUcsU0FBTixJQUFtQixDQUFDLEtBQUtDLFNBQTdCLEVBQXdDO0FBQ3BDLHVCQUFPLEtBQUsyRixLQUFMLENBQVcsd0JBQVgsQ0FBUDtBQUNIOztBQUVELGlCQUFLRCxZQUFMLENBQWtCLFNBQWxCO0FBQ0EsbUJBQU8sSUFBUDtBQUNILFNBZFc7O0FBZ0JabUIsb0JBQVksWUFBWTtBQUNwQixpQkFBS25CLFlBQUwsQ0FBa0IsWUFBbEIsRUFBZ0MsZUFBaEM7QUFDQSxpQkFBSzdFLEtBQUwsQ0FBV29GLEdBQVgsQ0FBZSxPQUFmO0FBQ0EsaUJBQUtwRixLQUFMLENBQVdvRixHQUFYLENBQWUsU0FBZjtBQUNBLGlCQUFLcEYsS0FBTCxDQUFXb0YsR0FBWCxDQUFlLE1BQWY7QUFDSCxTQXJCVzs7QUF1QlphLHNCQUFjLFVBQVVDLE1BQVYsRUFBa0I7QUFDNUIsaUJBQUs5RyxhQUFMLEdBQXFCOEcsTUFBckI7QUFDQSxpQkFBSzVHLFVBQUwsR0FBa0IsZ0JBQWxCO0FBQ0E2Ryx1QkFBVyxLQUFLQyxTQUFMLENBQWV6QyxJQUFmLENBQW9CLElBQXBCLENBQVgsRUFBc0MsQ0FBdEM7QUFDSCxTQTNCVzs7QUE2QlowQyx3QkFBZ0IsWUFBWTtBQUN4QixnQkFBSSxLQUFLL0csVUFBTCxLQUFvQixRQUFwQixJQUFnQyxLQUFLZ0gsVUFBekMsRUFBcUQ7QUFBRSx1QkFBTyxLQUFQO0FBQWU7QUFDdEUsMkJBQUtkLElBQUwsQ0FBVSxzQkFBVjs7QUFFQXhHLGdCQUFJdUgsUUFBSixDQUFhQyxRQUFiLENBQXNCLEtBQUt4RyxLQUEzQixFQUFrQyxpQkFBU3lHLFlBQTNDLEVBQXlELENBQXpEO0FBQ0F6SCxnQkFBSXVILFFBQUosQ0FBYUMsUUFBYixDQUFzQixLQUFLeEcsS0FBM0IsRUFBa0MsaUJBQVMwRyxRQUEzQyxFQUFxRCxDQUFyRDtBQUNBMUgsZ0JBQUl1SCxRQUFKLENBQWFDLFFBQWIsQ0FBc0IsS0FBS3hHLEtBQTNCLEVBQWtDLGlCQUFTMkcsU0FBM0MsRUFBc0QsQ0FBdEQ7QUFDQTNILGdCQUFJdUgsUUFBSixDQUFhQyxRQUFiLENBQXNCLEtBQUt4RyxLQUEzQixFQUFrQyxpQkFBUzJHLFNBQTNDLEVBQXNELENBQXREO0FBQ0EzSCxnQkFBSXVILFFBQUosQ0FBYUMsUUFBYixDQUFzQixLQUFLeEcsS0FBM0IsRUFBa0MsaUJBQVMwRyxRQUEzQyxFQUFxRCxDQUFyRDtBQUNBMUgsZ0JBQUl1SCxRQUFKLENBQWFDLFFBQWIsQ0FBc0IsS0FBS3hHLEtBQTNCLEVBQWtDLGlCQUFTeUcsWUFBM0MsRUFBeUQsQ0FBekQ7QUFDQSxtQkFBTyxJQUFQO0FBQ0gsU0F4Q1c7O0FBMENaRyxlQUFPLFVBQVVDLEdBQVYsRUFBZUMsRUFBZixFQUFtQjtBQUN0QixnQkFBSSxLQUFLbkgsWUFBTCxHQUFvQmtILEdBQXhCLEVBQTZCO0FBQUUsdUJBQU8sS0FBUDtBQUFlO0FBQzlDLDJCQUFLckIsSUFBTCxDQUFVLDJCQUEyQnNCLEVBQTNCLEdBQWdDLFlBQWhDLEdBQStDRCxHQUEvQyxHQUFxRCxHQUEvRDtBQUNBLGlCQUFLN0csS0FBTCxDQUFXK0csV0FBWCxDQUF1QixhQUFhQyxPQUFPQyxZQUFQLENBQW9CSixHQUFwQixDQUFiLEdBQXdDRyxPQUFPQyxZQUFQLENBQW9CSCxFQUFwQixDQUEvRDtBQUNBLG1CQUFPLElBQVA7QUFDSCxTQS9DVzs7QUFpRFpJLHFCQUFhLFlBQVk7QUFDckIsbUJBQU8sS0FBS04sS0FBTCxDQUFXLENBQVgsRUFBYyxDQUFkLENBQVA7QUFDSCxTQW5EVzs7QUFxRFpPLG1CQUFXLFlBQVk7QUFDbkIsbUJBQU8sS0FBS1AsS0FBTCxDQUFXLENBQVgsRUFBYyxDQUFkLENBQVA7QUFDSCxTQXZEVzs7QUF5RFpRLGtCQUFVLFlBQVk7QUFDbEIsbUJBQU8sS0FBS1IsS0FBTCxDQUFXLENBQVgsRUFBYyxDQUFkLENBQVA7QUFDSCxTQTNEVzs7QUE2RFo7QUFDQTtBQUNBUyxpQkFBUyxVQUFVbkMsSUFBVixFQUFnQm9DLElBQWhCLEVBQXNCO0FBQzNCLGdCQUFJLEtBQUtoSSxVQUFMLEtBQW9CLFFBQXBCLElBQWdDLEtBQUtnSCxVQUF6QyxFQUFxRDtBQUFFLHVCQUFPLEtBQVA7QUFBZTtBQUN0RSxnQkFBSSxPQUFPZ0IsSUFBUCxLQUFnQixXQUFwQixFQUFpQztBQUM3QiwrQkFBSzlCLElBQUwsQ0FBVSx3QkFBd0I4QixPQUFPLE1BQVAsR0FBZ0IsSUFBeEMsSUFBZ0QsS0FBaEQsR0FBd0RwQyxJQUFsRTtBQUNBbEcsb0JBQUl1SCxRQUFKLENBQWFDLFFBQWIsQ0FBc0IsS0FBS3hHLEtBQTNCLEVBQWtDa0YsSUFBbEMsRUFBd0NvQyxPQUFPLENBQVAsR0FBVyxDQUFuRDtBQUNILGFBSEQsTUFHTztBQUNILCtCQUFLOUIsSUFBTCxDQUFVLG1DQUFtQ04sSUFBN0M7QUFDQWxHLG9CQUFJdUgsUUFBSixDQUFhQyxRQUFiLENBQXNCLEtBQUt4RyxLQUEzQixFQUFrQ2tGLElBQWxDLEVBQXdDLENBQXhDO0FBQ0FsRyxvQkFBSXVILFFBQUosQ0FBYUMsUUFBYixDQUFzQixLQUFLeEcsS0FBM0IsRUFBa0NrRixJQUFsQyxFQUF3QyxDQUF4QztBQUNIO0FBQ0QsbUJBQU8sSUFBUDtBQUNILFNBMUVXOztBQTRFWnFDLDRCQUFvQixVQUFVQyxJQUFWLEVBQWdCO0FBQ2hDLGdCQUFJLEtBQUtsSSxVQUFMLEtBQW9CLFFBQXhCLEVBQWtDO0FBQUU7QUFBUztBQUM3Q04sZ0JBQUl1SCxRQUFKLENBQWFrQixhQUFiLENBQTJCLEtBQUt6SCxLQUFoQyxFQUF1Q3dILElBQXZDO0FBQ0gsU0EvRVc7O0FBaUZaO0FBQ0E7QUFDQUUsNEJBQW9CLFVBQVV6RyxLQUFWLEVBQWlCQyxNQUFqQixFQUF5QjtBQUN6QyxnQkFBSSxLQUFLNUIsVUFBTCxLQUFvQixRQUF4QixFQUFrQztBQUFFO0FBQVM7O0FBRTdDLGdCQUFJLEtBQUtvRCx1QkFBVCxFQUFrQztBQUM5QjFELG9CQUFJdUgsUUFBSixDQUFhb0IsY0FBYixDQUE0QixLQUFLM0gsS0FBakMsRUFBd0NpQixLQUF4QyxFQUErQ0MsTUFBL0MsRUFDNEIsS0FBS3lCLFVBRGpDLEVBQzZDLEtBQUtDLGFBRGxEO0FBRUEscUJBQUs1QyxLQUFMLENBQVc0SCxLQUFYO0FBQ0g7QUFDSixTQTNGVzs7QUE4Rlo7O0FBRUFDLGtCQUFVLFlBQVk7QUFDbEIsMkJBQUt4RSxLQUFMLENBQVcsZ0JBQVg7O0FBRUEsZ0JBQUl5RSxHQUFKO0FBQ0EsZ0JBQUksT0FBT0MsYUFBUCxLQUF5QixXQUE3QixFQUEwQztBQUN0Q0Qsc0JBQU0sTUFBTjtBQUNILGFBRkQsTUFFTztBQUNIQSxzQkFBTSxLQUFLRSxRQUFMLEdBQWdCLEtBQWhCLEdBQXdCLElBQTlCO0FBQ0g7O0FBRURGLG1CQUFPLFFBQVEsS0FBSzVJLFNBQWIsR0FBeUIsR0FBekIsR0FBK0IsS0FBS0MsU0FBcEMsR0FBZ0QsR0FBaEQsR0FBc0QsS0FBS0UsU0FBbEU7QUFDQSwyQkFBS21HLElBQUwsQ0FBVSxtQkFBbUJzQyxHQUE3Qjs7QUFFQSxpQkFBSzlILEtBQUwsQ0FBV2lJLElBQVgsQ0FBZ0JILEdBQWhCLEVBQXFCLEtBQUtJLFlBQTFCOztBQUVBLDJCQUFLN0UsS0FBTCxDQUFXLGdCQUFYO0FBQ0gsU0FoSFc7O0FBa0haZ0Msb0JBQVksWUFBWTtBQUNwQjtBQUNBLGlCQUFLNUUsSUFBTCxDQUFVQyxLQUFWLEdBQXlCLENBQXpCO0FBQ0EsaUJBQUtELElBQUwsQ0FBVUUsUUFBVixHQUF5QixDQUF6QixDQUhvQixDQUdTO0FBQzdCLGlCQUFLRixJQUFMLENBQVVHLEtBQVYsR0FBeUIsQ0FBekIsQ0FKb0IsQ0FJUztBQUM3QixpQkFBS0gsSUFBTCxDQUFVSSxLQUFWLEdBQXlCLENBQXpCLENBTG9CLENBS1M7QUFDN0IsaUJBQUtKLElBQUwsQ0FBVTBILEtBQVYsR0FBeUIsRUFBekIsQ0FOb0IsQ0FNUztBQUM3QixpQkFBS3RGLGlCQUFMLEdBQXlCLENBQXpCO0FBQ0EsaUJBQUtDLFVBQUwsR0FBeUIsRUFBekI7QUFDQSxpQkFBS3BELGFBQUwsR0FBeUIsS0FBekI7O0FBRUE7QUFDQSxnQkFBSWtFLENBQUo7QUFDQSxpQkFBS0EsSUFBSSxDQUFULEVBQVlBLElBQUksS0FBS2hFLFVBQUwsQ0FBZ0JpRSxNQUFoQyxFQUF3Q0QsR0FBeEMsRUFBNkM7QUFDekMscUJBQUs3RCxTQUFMLENBQWUsS0FBS0gsVUFBTCxDQUFnQmdFLENBQWhCLEVBQW1CLENBQW5CLENBQWYsRUFBc0MsQ0FBdEMsSUFBMkMsQ0FBM0M7QUFDSDs7QUFFRCxpQkFBS0EsSUFBSSxDQUFULEVBQVlBLElBQUksQ0FBaEIsRUFBbUJBLEdBQW5CLEVBQXdCO0FBQ3BCLHFCQUFLbkQsSUFBTCxDQUFVMEgsS0FBVixDQUFnQnZFLENBQWhCLElBQXFCLElBQUksbUJBQVN3RSxPQUFiLEVBQXJCO0FBQ0g7QUFDSixTQXRJVzs7QUF3SVpDLHNCQUFjLFlBQVk7QUFDdEIsMkJBQUs3QyxJQUFMLENBQVUscUNBQVY7QUFDQSxnQkFBSTVCLENBQUosRUFBTzBFLENBQVA7QUFDQSxpQkFBSzFFLElBQUksQ0FBVCxFQUFZQSxJQUFJLEtBQUtoRSxVQUFMLENBQWdCaUUsTUFBaEMsRUFBd0NELEdBQXhDLEVBQTZDO0FBQ3pDMEUsb0JBQUksS0FBS3ZJLFNBQUwsQ0FBZSxLQUFLSCxVQUFMLENBQWdCZ0UsQ0FBaEIsRUFBbUIsQ0FBbkIsQ0FBZixDQUFKO0FBQ0Esb0JBQUkwRSxFQUFFLENBQUYsSUFBT0EsRUFBRSxDQUFGLENBQVAsR0FBYyxDQUFsQixFQUFxQjtBQUNqQixtQ0FBSzlDLElBQUwsQ0FBVSxTQUFTLEtBQUs1RixVQUFMLENBQWdCZ0UsQ0FBaEIsRUFBbUIsQ0FBbkIsQ0FBVCxHQUFpQyxJQUFqQyxHQUF3QzBFLEVBQUUsQ0FBRixDQUF4QyxHQUErQyxRQUF6RDtBQUNIO0FBQ0o7O0FBRUQsMkJBQUs5QyxJQUFMLENBQVUsaUNBQVY7QUFDQSxpQkFBSzVCLElBQUksQ0FBVCxFQUFZQSxJQUFJLEtBQUtoRSxVQUFMLENBQWdCaUUsTUFBaEMsRUFBd0NELEdBQXhDLEVBQTZDO0FBQ3pDMEUsb0JBQUksS0FBS3ZJLFNBQUwsQ0FBZSxLQUFLSCxVQUFMLENBQWdCZ0UsQ0FBaEIsRUFBbUIsQ0FBbkIsQ0FBZixDQUFKO0FBQ0EsK0JBQUs0QixJQUFMLENBQVUsU0FBUyxLQUFLNUYsVUFBTCxDQUFnQmdFLENBQWhCLEVBQW1CLENBQW5CLENBQVQsR0FBaUMsSUFBakMsR0FBd0MwRSxFQUFFLENBQUYsQ0FBeEMsR0FBK0MsUUFBekQ7QUFDSDtBQUNKLFNBdkpXOztBQXlKWkMsd0JBQWdCLFVBQVVDLEtBQVYsRUFBaUI7QUFDN0IsZ0JBQUksS0FBS25JLFNBQVQsRUFBb0I7QUFDaEJvSSw4QkFBYyxLQUFLcEksU0FBbkI7QUFDQSxxQkFBS0EsU0FBTCxHQUFpQixJQUFqQjtBQUNIOztBQUVELGdCQUFJLEtBQUtKLFFBQUwsSUFBaUIsS0FBS0EsUUFBTCxDQUFjeUksV0FBZCxFQUFyQixFQUFrRDtBQUM5QyxxQkFBS3hJLFNBQUwsQ0FBZXlJLE1BQWY7QUFDQSxxQkFBS3hJLE1BQUwsQ0FBWXdJLE1BQVo7QUFDQSxvQkFBSUgsVUFBVSxTQUFWLElBQXVCQSxVQUFVLFFBQXJDLEVBQStDO0FBQzNDLHlCQUFLdkksUUFBTCxDQUFjMkksYUFBZDtBQUNIO0FBQ0Qsb0JBQUksZUFBS0MsV0FBTCxPQUF1QixPQUF2QixJQUFrQ0wsVUFBVSxRQUFoRCxFQUEwRDtBQUN0RDtBQUNBO0FBQ0EseUJBQUt2SSxRQUFMLENBQWM2SSxLQUFkO0FBQ0g7QUFDSjs7QUFFRCxpQkFBSzlJLEtBQUwsQ0FBVytJLEtBQVg7QUFDSCxTQTdLVzs7QUErS1o7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFtQkFsRSxzQkFBYyxVQUFVMkQsS0FBVixFQUFpQlEsU0FBakIsRUFBNEI7QUFDdEMsZ0JBQUlDLFdBQVcsS0FBSzNKLFVBQXBCOztBQUVBLGdCQUFJa0osVUFBVVMsUUFBZCxFQUF3QjtBQUNwQjtBQUNBLCtCQUFLNUYsS0FBTCxDQUFXLHVCQUF1Qm1GLEtBQXZCLEdBQStCLGFBQTFDO0FBQ0g7O0FBRUQ7Ozs7QUFJQSxnQkFBSUEsU0FBUyxFQUFDLGdCQUFnQixDQUFqQixFQUFvQixVQUFVLENBQTlCLEVBQWlDLFdBQVcsQ0FBNUM7QUFDQyw4QkFBYyxDQURmLEVBQ2tCLFVBQVUsQ0FENUIsRUFDK0IsU0FBUyxDQUR4QyxFQUFiLEVBQ3lEO0FBQ3JELHFCQUFLRCxjQUFMLENBQW9CQyxLQUFwQjtBQUNIOztBQUVELGdCQUFJUyxhQUFhLE9BQWpCLEVBQTBCO0FBQ3RCLCtCQUFLaEYsS0FBTCxDQUFXLDhCQUFYO0FBQ0g7O0FBRUQsZ0JBQUlpRixPQUFPLE9BQU9GLFNBQVAsS0FBc0IsV0FBdEIsR0FBcUMsV0FBV0EsU0FBaEQsR0FBNkQsRUFBeEU7QUFDQSxnQkFBSUcsVUFBVSxnQkFBZ0JYLEtBQWhCLEdBQXdCLFVBQXhCLEdBQXFDUyxRQUFyQyxHQUFnRCxJQUFoRCxHQUF1REMsSUFBckU7QUFDQSxnQkFBSVYsVUFBVSxRQUFWLElBQXNCQSxVQUFVLE9BQXBDLEVBQTZDO0FBQ3pDLCtCQUFLdkUsS0FBTCxDQUFXaUYsSUFBWDtBQUNILGFBRkQsTUFFTztBQUNILCtCQUFLbEUsSUFBTCxDQUFVa0UsSUFBVjtBQUNIOztBQUVELGdCQUFJRCxhQUFhLFFBQWIsSUFBeUJULFVBQVUsY0FBdkMsRUFBdUQ7QUFDbkQ7QUFDQSxxQkFBS2xKLFVBQUwsR0FBa0IsUUFBbEI7QUFDSCxhQUhELE1BR087QUFDSCxxQkFBS0EsVUFBTCxHQUFrQmtKLEtBQWxCO0FBQ0g7O0FBRUQsZ0JBQUksS0FBS3BJLGFBQUwsSUFBc0IsS0FBS2QsVUFBTCxLQUFvQixZQUE5QyxFQUE0RDtBQUN4RCwrQkFBSytELEtBQUwsQ0FBVywyQkFBWDtBQUNBK0YsNkJBQWEsS0FBS2hKLGFBQWxCO0FBQ0EscUJBQUtBLGFBQUwsR0FBcUIsSUFBckI7QUFDQSxxQkFBS0osS0FBTCxDQUFXb0YsR0FBWCxDQUFlLE9BQWYsRUFKd0QsQ0FJOUI7QUFDN0I7O0FBRUQsb0JBQVFvRCxLQUFSO0FBQ0kscUJBQUssUUFBTDtBQUNJLHdCQUFJUyxhQUFhLGNBQWIsSUFBK0JBLGFBQWEsUUFBaEQsRUFBMEQ7QUFDdEQsdUNBQUtoRixLQUFMLENBQVcsZ0VBQVg7QUFDSDtBQUNEOztBQUVKLHFCQUFLLFNBQUw7QUFDSSx5QkFBS29CLFVBQUw7QUFDQSx5QkFBS3dDLFFBQUw7QUFDQTtBQUNBOztBQUVKLHFCQUFLLFlBQUw7QUFDSSx5QkFBS3pILGFBQUwsR0FBcUIrRixXQUFXLFlBQVk7QUFDeEMsNkJBQUtyQixLQUFMLENBQVcsb0JBQVg7QUFDSCxxQkFGK0IsQ0FFOUJuQixJQUY4QixDQUV6QixJQUZ5QixDQUFYLEVBRVAsS0FBSzBGLGtCQUFMLEdBQTBCLElBRm5CLENBQXJCOztBQUlBLHlCQUFLaEIsWUFBTDs7QUFFQTtBQUNBOztBQUVKLHFCQUFLLFFBQUw7QUFDSSx3QkFBSVksYUFBYSxjQUFqQixFQUFpQztBQUM3Qix1Q0FBS2hGLEtBQUwsQ0FBVyxvREFBWDtBQUNILHFCQUZELE1BRU8sSUFBSWdGLGFBQWEsUUFBakIsRUFBMkI7QUFDOUIsdUNBQUtoRixLQUFMLENBQVcsd0JBQVg7QUFDSCxxQkFGTSxNQUVBLElBQUlnRixhQUFhLE1BQWpCLEVBQXlCO0FBQzVCLHVDQUFLaEYsS0FBTCxDQUFXLDJCQUFYO0FBQ0g7O0FBRUQ7QUFDQWtDLCtCQUFXLFlBQVk7QUFDbkIsNkJBQUt0QixZQUFMLENBQWtCLGNBQWxCO0FBQ0gscUJBRlUsQ0FFVGxCLElBRlMsQ0FFSixJQUZJLENBQVgsRUFFYyxFQUZkOztBQUlBOztBQUVKO0FBQ0k7QUF4Q1I7O0FBMkNBLGdCQUFJc0YsYUFBYSxRQUFiLElBQXlCVCxVQUFVLGNBQXZDLEVBQXVEO0FBQ25ELHFCQUFLYyxjQUFMLENBQW9CLElBQXBCLEVBQTBCZCxLQUExQixFQUFpQ1MsUUFBakM7QUFDSCxhQUZELE1BRU87QUFDSCxxQkFBS0ssY0FBTCxDQUFvQixJQUFwQixFQUEwQmQsS0FBMUIsRUFBaUNTLFFBQWpDLEVBQTJDRCxTQUEzQztBQUNIO0FBQ0osU0E3Ulc7O0FBK1JabEUsZUFBTyxVQUFVRyxHQUFWLEVBQWU7QUFDbEIsaUJBQUtKLFlBQUwsQ0FBa0IsUUFBbEIsRUFBNEJJLEdBQTVCO0FBQ0EsbUJBQU8sS0FBUDtBQUNILFNBbFNXOztBQW9TWkwseUJBQWlCLFlBQVk7QUFDekIsZ0JBQUksS0FBSzVFLEtBQUwsQ0FBV3VKLEtBQVgsT0FBdUIsQ0FBM0IsRUFBOEI7QUFDMUIsK0JBQUt2RSxJQUFMLENBQVUsaURBQVY7QUFDQTtBQUNIOztBQUVELG9CQUFRLEtBQUsxRixVQUFiO0FBQ0kscUJBQUssY0FBTDtBQUNBLHFCQUFLLFFBQUw7QUFDSSxtQ0FBSzJFLEtBQUwsQ0FBVyw2QkFBWDtBQUNBO0FBQ0oscUJBQUssUUFBTDtBQUNJLHdCQUFJLEtBQUt1RixXQUFMLE1BQXNCLEtBQUt4SixLQUFMLENBQVd1SixLQUFYLEtBQXFCLENBQS9DLEVBQWtEO0FBQzlDO0FBQ0E7QUFDQSw0QkFBSSxLQUFLbEosU0FBTCxLQUFtQixJQUF2QixFQUE2QjtBQUN6QiwyQ0FBS2dELEtBQUwsQ0FBVyxzQ0FBWDtBQUNBLGlDQUFLaEQsU0FBTCxHQUFpQjhGLFdBQVcsWUFBWTtBQUNwQyxxQ0FBSzlGLFNBQUwsR0FBaUIsSUFBakI7QUFDQSxxQ0FBS3VFLGVBQUw7QUFDSCw2QkFIMkIsQ0FHMUJqQixJQUgwQixDQUdyQixJQUhxQixDQUFYLEVBR0gsQ0FIRyxDQUFqQjtBQUlILHlCQU5ELE1BTU87QUFDSCwyQ0FBS04sS0FBTCxDQUFXLHNDQUFYO0FBQ0g7QUFDSjtBQUNEO0FBQ0o7QUFDSSx5QkFBSytDLFNBQUw7QUFDQTtBQXRCUjtBQXdCSCxTQWxVVzs7QUFvVVpoQyx5QkFBaUIsVUFBVXFGLFFBQVYsRUFBb0I7QUFDakMsZ0JBQUksS0FBS25ELFVBQVQsRUFBcUI7QUFBRTtBQUFTLGFBREMsQ0FDQTs7QUFFakMsZ0JBQUlnQixPQUFRbUMsU0FBU0MsSUFBVCxJQUFpQixTQUE3QjtBQUNBLGdCQUFJLEtBQUt4Ryx5QkFBVCxFQUFvQztBQUNoQyxvQkFBSXlHLFdBQVcsc0JBQVdGLFNBQVN2RSxJQUFwQixDQUFmO0FBQ0Esb0JBQUl5RSxRQUFKLEVBQWM7QUFDVix3QkFBSUMsU0FBU0gsU0FBU0csTUFBdEI7QUFDQTVLLHdCQUFJdUgsUUFBSixDQUFhc0Qsb0JBQWIsQ0FBa0MsS0FBSzdKLEtBQXZDLEVBQThDNEosTUFBOUMsRUFBc0R0QyxJQUF0RCxFQUE0RHFDLFFBQTVEO0FBQ0gsaUJBSEQsTUFHTztBQUNILG1DQUFLMUYsS0FBTCxDQUFXLDZDQUE2Q3dGLFNBQVN2RSxJQUFqRTtBQUNIO0FBQ0osYUFSRCxNQVFPO0FBQ0gwRSx5QkFBU0gsU0FBU0csTUFBVCxDQUFnQkEsTUFBekI7QUFDQTVLLG9CQUFJdUgsUUFBSixDQUFhQyxRQUFiLENBQXNCLEtBQUt4RyxLQUEzQixFQUFrQzRKLE1BQWxDLEVBQTBDdEMsSUFBMUM7QUFDSDtBQUNKLFNBcFZXOztBQXNWWmhELDRCQUFvQixVQUFVdkQsQ0FBVixFQUFhQyxDQUFiLEVBQWdCc0csSUFBaEIsRUFBc0J3QyxLQUF0QixFQUE2QjtBQUM3QyxnQkFBSXhDLElBQUosRUFBVTtBQUNOLHFCQUFLekUsaUJBQUwsSUFBMEJpSCxLQUExQjtBQUNILGFBRkQsTUFFTztBQUNILHFCQUFLakgsaUJBQUwsSUFBMEJpSCxLQUExQjtBQUNIOztBQUVELGdCQUFJLEtBQUtDLGFBQVQsRUFBd0I7QUFDcEIsb0JBQUl6QyxRQUFRLENBQUMsS0FBS3ZFLGlCQUFsQixFQUFxQztBQUNqQyx5QkFBS0EsaUJBQUwsR0FBeUIsSUFBekI7QUFDQSx5QkFBS0MsZ0JBQUwsR0FBd0IsRUFBQyxLQUFLakMsQ0FBTixFQUFTLEtBQUtDLENBQWQsRUFBeEI7O0FBRUE7QUFDQTtBQUNILGlCQU5ELE1BTU87QUFDSCx5QkFBSytCLGlCQUFMLEdBQXlCLEtBQXpCOztBQUVBO0FBQ0E7QUFDQSx3QkFBSSxDQUFDLEtBQUtFLGlCQUFOLElBQTJCLENBQUMsS0FBS3FELFVBQXJDLEVBQWlEO0FBQzdDdEgsNEJBQUl1SCxRQUFKLENBQWF5RCxZQUFiLENBQTBCLEtBQUtoSyxLQUEvQixFQUFzQyxLQUFLQyxRQUFMLENBQWNnSyxJQUFkLENBQW1CbEosQ0FBbkIsQ0FBdEMsRUFBNkQsS0FBS2QsUUFBTCxDQUFjaUssSUFBZCxDQUFtQmxKLENBQW5CLENBQTdELEVBQW9GOEksS0FBcEY7QUFDSDtBQUNELHlCQUFLN0csaUJBQUwsR0FBeUIsS0FBekI7QUFDSDtBQUNKOztBQUVELGdCQUFJLEtBQUtxRCxVQUFULEVBQXFCO0FBQUU7QUFBUyxhQTFCYSxDQTBCWjs7QUFFakMsZ0JBQUksS0FBS2hILFVBQUwsS0FBb0IsUUFBeEIsRUFBa0M7QUFBRTtBQUFTO0FBQzdDTixnQkFBSXVILFFBQUosQ0FBYXlELFlBQWIsQ0FBMEIsS0FBS2hLLEtBQS9CLEVBQXNDLEtBQUtDLFFBQUwsQ0FBY2dLLElBQWQsQ0FBbUJsSixDQUFuQixDQUF0QyxFQUE2RCxLQUFLZCxRQUFMLENBQWNpSyxJQUFkLENBQW1CbEosQ0FBbkIsQ0FBN0QsRUFBb0YsS0FBSzZCLGlCQUF6RjtBQUNILFNBcFhXOztBQXNYWjJCLDBCQUFrQixVQUFVekQsQ0FBVixFQUFhQyxDQUFiLEVBQWdCO0FBQzlCLGdCQUFJLEtBQUsrQixpQkFBVCxFQUE0QjtBQUN4QixvQkFBSW9ILFNBQVMsS0FBS25ILGdCQUFMLENBQXNCakMsQ0FBdEIsR0FBMEJBLENBQXZDO0FBQ0Esb0JBQUlxSixTQUFTLEtBQUtwSCxnQkFBTCxDQUFzQmhDLENBQXRCLEdBQTBCQSxDQUF2Qzs7QUFFQTtBQUNBO0FBQ0Esb0JBQUlxSixnQkFBZ0IsTUFBTUMsT0FBT0MsZ0JBQVAsSUFBMkIsQ0FBakMsQ0FBcEI7O0FBRUEsb0JBQUksS0FBS3RILGlCQUFMLElBQTJCdUgsS0FBS0MsR0FBTCxDQUFTTixNQUFULElBQW1CRSxhQUFuQixJQUNBRyxLQUFLQyxHQUFMLENBQVNMLE1BQVQsSUFBbUJDLGFBRGxELEVBQ2tFO0FBQzlELHlCQUFLcEgsaUJBQUwsR0FBeUIsSUFBekI7O0FBRUEseUJBQUtELGdCQUFMLEdBQXdCLEVBQUMsS0FBS2pDLENBQU4sRUFBUyxLQUFLQyxDQUFkLEVBQXhCO0FBQ0EseUJBQUtmLFFBQUwsQ0FBY3lLLGlCQUFkLENBQWdDUCxNQUFoQyxFQUF3Q0MsTUFBeEM7QUFDSDs7QUFFRDtBQUNBO0FBQ0g7O0FBRUQsZ0JBQUksS0FBSzlELFVBQVQsRUFBcUI7QUFBRTtBQUFTLGFBckJGLENBcUJHOztBQUVqQyxnQkFBSSxLQUFLaEgsVUFBTCxLQUFvQixRQUF4QixFQUFrQztBQUFFO0FBQVM7QUFDN0NOLGdCQUFJdUgsUUFBSixDQUFheUQsWUFBYixDQUEwQixLQUFLaEssS0FBL0IsRUFBc0MsS0FBS0MsUUFBTCxDQUFjZ0ssSUFBZCxDQUFtQmxKLENBQW5CLENBQXRDLEVBQTZELEtBQUtkLFFBQUwsQ0FBY2lLLElBQWQsQ0FBbUJsSixDQUFuQixDQUE3RCxFQUFvRixLQUFLNkIsaUJBQXpGO0FBQ0gsU0EvWVc7O0FBaVpaOztBQUVBOEgscUNBQTZCLFlBQVk7QUFDckMsZ0JBQUksS0FBSzNLLEtBQUwsQ0FBV3VKLEtBQVgsS0FBcUIsRUFBekIsRUFBNkI7QUFDekIsdUJBQU8sS0FBS3pFLEtBQUwsQ0FBVyw2QkFBWCxDQUFQO0FBQ0g7O0FBRUQsZ0JBQUk4RixXQUFXLEtBQUs1SyxLQUFMLENBQVc2SyxVQUFYLENBQXNCLEVBQXRCLEVBQTBCQyxNQUExQixDQUFpQyxDQUFqQyxFQUFvQyxDQUFwQyxDQUFmO0FBQ0EsMkJBQUt0RixJQUFMLENBQVUsNkJBQTZCb0YsUUFBdkM7QUFDQSxnQkFBSUcsY0FBYyxDQUFsQjtBQUNBLG9CQUFRSCxRQUFSO0FBQ0kscUJBQUssU0FBTDtBQUFpQjtBQUNiRyxrQ0FBYyxDQUFkO0FBQ0E7QUFDSixxQkFBSyxTQUFMO0FBQ0EscUJBQUssU0FBTCxDQUxKLENBS3FCO0FBQ2pCLHFCQUFLLFNBQUw7QUFBaUI7QUFDYix5QkFBS3hMLFlBQUwsR0FBb0IsR0FBcEI7QUFDQTtBQUNKLHFCQUFLLFNBQUw7QUFDSSx5QkFBS0EsWUFBTCxHQUFvQixHQUFwQjtBQUNBO0FBQ0oscUJBQUssU0FBTDtBQUNBLHFCQUFLLFNBQUwsQ0FiSixDQWFxQjtBQUNqQixxQkFBSyxTQUFMLENBZEosQ0FjcUI7QUFDakIscUJBQUssU0FBTDtBQUFpQjtBQUNiLHlCQUFLQSxZQUFMLEdBQW9CLEdBQXBCO0FBQ0E7QUFDSjtBQUNJLDJCQUFPLEtBQUt1RixLQUFMLENBQVcsNEJBQTRCOEYsUUFBdkMsQ0FBUDtBQW5CUjs7QUFzQkEsZ0JBQUlHLFdBQUosRUFBaUI7QUFDYixvQkFBSUMsYUFBYSxLQUFLQyxXQUF0QjtBQUNBLHVCQUFPRCxXQUFXbkgsTUFBWCxHQUFvQixHQUEzQixFQUFnQztBQUM1Qm1ILGtDQUFjLElBQWQ7QUFDSDtBQUNELHFCQUFLaEwsS0FBTCxDQUFXK0csV0FBWCxDQUF1QmlFLFVBQXZCO0FBQ0EsdUJBQU8sSUFBUDtBQUNIOztBQUVELGdCQUFJLEtBQUt6TCxZQUFMLEdBQW9CLEtBQUtDLGdCQUE3QixFQUErQztBQUMzQyxxQkFBS0QsWUFBTCxHQUFvQixLQUFLQyxnQkFBekI7QUFDSDs7QUFFRCxnQkFBSTBMLFdBQVcsT0FBT0MsU0FBUyxLQUFLNUwsWUFBZCxFQUE0QixFQUE1QixDQUFQLEdBQ0EsS0FEQSxHQUNVLEtBQUtBLFlBQUwsR0FBb0IsRUFBckIsR0FBMkIsRUFEbkQ7QUFFQSxpQkFBS1MsS0FBTCxDQUFXK0csV0FBWCxDQUF1QixTQUFTbUUsUUFBVCxHQUFvQixJQUEzQztBQUNBLGlCQUFLckcsWUFBTCxDQUFrQixVQUFsQixFQUE4QiwyQkFBMkJxRyxRQUF6RDtBQUNILFNBbGNXOztBQW9jWkUsNkJBQXFCLFlBQVk7QUFDN0IsZ0JBQUksS0FBSzdMLFlBQUwsSUFBcUIsR0FBekIsRUFBOEI7QUFDMUI7QUFDQSxvQkFBSThMLFlBQVksS0FBS3JMLEtBQUwsQ0FBV3NMLFFBQVgsRUFBaEI7QUFDQSxvQkFBSSxLQUFLdEwsS0FBTCxDQUFXdUwsTUFBWCxDQUFrQixlQUFsQixFQUFtQ0YsU0FBbkMsRUFBOEMsQ0FBOUMsQ0FBSixFQUFzRDtBQUFFLDJCQUFPLEtBQVA7QUFBZTs7QUFFdkUsb0JBQUlBLGNBQWMsQ0FBbEIsRUFBcUI7QUFDakIsd0JBQUlHLFNBQVMsS0FBS3hMLEtBQUwsQ0FBV3lMLFNBQVgsRUFBYjtBQUNBLHdCQUFJdEcsU0FBUyxLQUFLbkYsS0FBTCxDQUFXNkssVUFBWCxDQUFzQlcsTUFBdEIsQ0FBYjtBQUNBLDJCQUFPLEtBQUsxRyxLQUFMLENBQVcsdUJBQXVCSyxNQUFsQyxDQUFQO0FBQ0g7O0FBRUQscUJBQUsxRixnQkFBTCxHQUF3QixDQUF4QjtBQUNBLG9CQUFJaU0sUUFBUSxLQUFLMUwsS0FBTCxDQUFXMkwsWUFBWCxDQUF3Qk4sU0FBeEIsQ0FBWjtBQUNBLCtCQUFLaEksS0FBTCxDQUFXLDRCQUE0QnFJLEtBQXZDO0FBQ0EscUJBQUssSUFBSTlILElBQUksQ0FBYixFQUFnQkEsSUFBSThILE1BQU03SCxNQUExQixFQUFrQ0QsR0FBbEMsRUFBdUM7QUFDbkMsd0JBQUk4SCxNQUFNOUgsQ0FBTixJQUFXLEtBQUtuRSxnQkFBaEIsS0FBcUNpTSxNQUFNOUgsQ0FBTixLQUFZLEVBQVosSUFBa0I4SCxNQUFNOUgsQ0FBTixLQUFZLEVBQW5FLENBQUosRUFBNEU7QUFDeEUsNkJBQUtuRSxnQkFBTCxHQUF3QmlNLE1BQU05SCxDQUFOLENBQXhCO0FBQ0g7QUFDSjs7QUFFRCxvQkFBSSxLQUFLbkUsZ0JBQUwsS0FBMEIsQ0FBOUIsRUFBaUM7QUFDN0IsMkJBQU8sS0FBS3FGLEtBQUwsQ0FBVyxpQ0FBaUM0RyxLQUE1QyxDQUFQO0FBQ0g7O0FBRUQscUJBQUsxTCxLQUFMLENBQVc0TCxJQUFYLENBQWdCLENBQUMsS0FBS25NLGdCQUFOLENBQWhCO0FBQ0gsYUF6QkQsTUF5Qk87QUFDSDtBQUNBLG9CQUFJLEtBQUtPLEtBQUwsQ0FBV3VMLE1BQVgsQ0FBa0IsaUJBQWxCLEVBQXFDLENBQXJDLENBQUosRUFBNkM7QUFBRSwyQkFBTyxLQUFQO0FBQWU7QUFDOUQscUJBQUs5TCxnQkFBTCxHQUF3QixLQUFLTyxLQUFMLENBQVd5TCxTQUFYLEVBQXhCO0FBQ0g7O0FBRUQsaUJBQUs1RyxZQUFMLENBQWtCLGdCQUFsQixFQUFvQyxrQ0FBa0MsS0FBS3BGLGdCQUEzRTtBQUNBLG1CQUFPLEtBQUsyRyxTQUFMLEVBQVAsQ0FqQzZCLENBaUNKO0FBQzVCLFNBdGVXOztBQXdlWjtBQUNBeUYsNkJBQXFCLFlBQVk7QUFDN0IsZ0JBQUlDLFVBQVUsS0FBS0MsaUJBQW5CO0FBQ0EsZ0JBQUlDLFdBQVcsS0FBSzVNLGFBQUwsQ0FBbUI2TSxLQUFuQixDQUF5QkgsT0FBekIsQ0FBZjtBQUNBLGdCQUFJRSxTQUFTbkksTUFBVCxHQUFrQixDQUF0QixFQUF5QjtBQUNyQixxQkFBS2dCLFlBQUwsQ0FBa0IsVUFBbEIsRUFBOEIsbUNBQW1DaUgsT0FBbkMsR0FDWixRQURZLEdBQ0RBLE9BREMsR0FDUyx3QkFEVCxHQUNvQyxLQUFLMU0sYUFEdkU7QUFFQSxxQkFBSzhNLG1CQUFMLENBQXlCLElBQXpCO0FBQ0EsdUJBQU8sS0FBUDtBQUNIOztBQUVELGdCQUFJQyxlQUFlbkYsT0FBT0MsWUFBUCxDQUFvQitFLFNBQVMsQ0FBVCxFQUFZbkksTUFBaEMsSUFDQW1ELE9BQU9DLFlBQVAsQ0FBb0IrRSxTQUFTLENBQVQsRUFBWW5JLE1BQWhDLENBREEsR0FFQW1JLFNBQVMsQ0FBVCxDQUZBLEdBR0FBLFNBQVMsQ0FBVCxDQUhuQjtBQUlBLGlCQUFLaE0sS0FBTCxDQUFXK0csV0FBWCxDQUF1Qm9GLFlBQXZCO0FBQ0EsaUJBQUsvTSxhQUFMLEdBQXFCNE0sU0FBU0ksS0FBVCxDQUFlLENBQWYsRUFBa0JDLElBQWxCLENBQXVCUCxPQUF2QixDQUFyQjtBQUNBLGlCQUFLck0sZ0JBQUwsR0FBd0IsQ0FBeEI7QUFDQSxtQkFBTyxLQUFLNk0seUJBQUwsRUFBUDtBQUNILFNBM2ZXOztBQTZmWkMsaUNBQXlCLFlBQVk7QUFDakMsZ0JBQUksS0FBS25OLGFBQUwsQ0FBbUJ5RSxNQUFuQixLQUE4QixDQUFsQyxFQUFxQztBQUNqQztBQUNBO0FBQ0EscUJBQUtnQixZQUFMLENBQWtCLFVBQWxCLEVBQThCLG1CQUE5QjtBQUNBLHFCQUFLcUgsbUJBQUwsQ0FBeUIsSUFBekI7QUFDQSx1QkFBTyxLQUFQO0FBQ0g7O0FBRUQsZ0JBQUksS0FBS2xNLEtBQUwsQ0FBV3VMLE1BQVgsQ0FBa0IsZ0JBQWxCLEVBQW9DLEVBQXBDLENBQUosRUFBNkM7QUFBRSx1QkFBTyxLQUFQO0FBQWU7O0FBRTlEO0FBQ0EsZ0JBQUlpQixZQUFZQyxNQUFNaEgsU0FBTixDQUFnQjJHLEtBQWhCLENBQXNCTSxJQUF0QixDQUEyQixLQUFLMU0sS0FBTCxDQUFXMkwsWUFBWCxDQUF3QixFQUF4QixDQUEzQixDQUFoQjtBQUNBLGdCQUFJZ0IsV0FBVzNOLElBQUk0TixNQUFKLENBQVcsS0FBS3hOLGFBQWhCLEVBQStCb04sU0FBL0IsQ0FBZjtBQUNBLGlCQUFLeE0sS0FBTCxDQUFXNEwsSUFBWCxDQUFnQmUsUUFBaEI7QUFDQSxpQkFBSzlILFlBQUwsQ0FBa0IsZ0JBQWxCO0FBQ0EsbUJBQU8sSUFBUDtBQUNILFNBOWdCVzs7QUFnaEJaZ0ksa0NBQTBCLFVBQVVDLFVBQVYsRUFBc0I7QUFDNUMsZ0JBQUlDLDZCQUE2QjtBQUM3QixtQkFBRyxFQUFFQyxRQUFRLE1BQVYsRUFBa0JDLFdBQVcsVUFBN0I7QUFEMEIsYUFBakM7QUFHQSxnQkFBSUMsNkJBQTZCLEVBQWpDO0FBQ0E7QUFDQSxpQkFBSyxJQUFJdEosSUFBSSxDQUFiLEVBQWdCQSxJQUFJa0osVUFBcEIsRUFBZ0NsSixHQUFoQyxFQUFxQztBQUNqQyxvQkFBSXVKLFdBQVcsS0FBS25OLEtBQUwsQ0FBV3lMLFNBQVgsRUFBZjtBQUNBLG9CQUFJMkIsYUFBYSxLQUFLcE4sS0FBTCxDQUFXNkssVUFBWCxDQUFzQixDQUF0QixDQUFqQjtBQUNBLG9CQUFJd0MsZ0JBQWdCLEtBQUtyTixLQUFMLENBQVc2SyxVQUFYLENBQXNCLENBQXRCLENBQXBCO0FBQ0FxQywyQ0FBMkJDLFFBQTNCLElBQXVDLEVBQUVILFFBQVFJLFVBQVYsRUFBc0JILFdBQVdJLGFBQWpDLEVBQXZDO0FBQ0g7O0FBRUQ7QUFDQSxnQkFBSUgsMkJBQTJCLENBQTNCLENBQUosRUFBbUM7QUFDL0Isb0JBQUlBLDJCQUEyQixDQUEzQixFQUE4QkYsTUFBOUIsSUFBd0NELDJCQUEyQixDQUEzQixFQUE4QkMsTUFBdEUsSUFDQUUsMkJBQTJCLENBQTNCLEVBQThCRCxTQUE5QixJQUEyQ0YsMkJBQTJCLENBQTNCLEVBQThCRSxTQUQ3RSxFQUN3RjtBQUNwRiwyQkFBTyxLQUFLbkksS0FBTCxDQUFXLDREQUFYLENBQVA7QUFDSDtBQUNELHFCQUFLOUUsS0FBTCxDQUFXNEwsSUFBWCxDQUFnQixDQUFDLENBQUQsRUFBSSxDQUFKLEVBQU8sQ0FBUCxFQUFVLENBQVYsQ0FBaEIsRUFMK0IsQ0FLQztBQUNoQyx1QkFBTyxLQUFQLENBTitCLENBTWpCO0FBQ2pCLGFBUEQsTUFPTztBQUNILHVCQUFPLEtBQUs5RyxLQUFMLENBQVcsOERBQVgsQ0FBUDtBQUNIO0FBQ0osU0F4aUJXOztBQTBpQlp3SSwrQkFBdUIsWUFBWTtBQUMvQixnQkFBSSxDQUFDLEtBQUs1TixhQUFWLEVBQXlCO0FBQUc7QUFDeEIsb0JBQUksS0FBS00sS0FBTCxDQUFXdUwsTUFBWCxDQUFrQixhQUFsQixFQUFpQyxDQUFqQyxDQUFKLEVBQXlDO0FBQUUsMkJBQU8sS0FBUDtBQUFlO0FBQzFELG9CQUFJdUIsYUFBYSxLQUFLOU0sS0FBTCxDQUFXeUwsU0FBWCxFQUFqQjtBQUNBLG9CQUFJcUIsYUFBYSxDQUFiLElBQWtCLEtBQUs5TSxLQUFMLENBQVd1TCxNQUFYLENBQWtCLHFCQUFsQixFQUF5QyxLQUFLdUIsVUFBOUMsRUFBMEQsQ0FBMUQsQ0FBdEIsRUFBb0Y7QUFBRSwyQkFBTyxLQUFQO0FBQWU7O0FBRXJHLHFCQUFLcE4sYUFBTCxHQUFxQixJQUFyQjs7QUFFQSxvQkFBSW9OLGFBQWEsQ0FBakIsRUFBb0I7QUFDaEIseUJBQUtELHdCQUFMLENBQThCQyxVQUE5QjtBQUNBLDJCQUFPLEtBQVAsQ0FGZ0IsQ0FFRDtBQUNsQjtBQUNKOztBQUVEO0FBQ0EsZ0JBQUksS0FBSzlNLEtBQUwsQ0FBV3VMLE1BQVgsQ0FBa0IsZ0JBQWxCLEVBQW9DLENBQXBDLENBQUosRUFBNEM7QUFBRSx1QkFBTyxLQUFQO0FBQWU7QUFDN0QsZ0JBQUlnQyxlQUFlLEtBQUt2TixLQUFMLENBQVd5TCxTQUFYLEVBQW5CO0FBQ0EsZ0JBQUk4QixpQkFBaUIsQ0FBckIsRUFBd0I7QUFBRztBQUN2QixxQkFBSzFJLFlBQUwsQ0FBa0IsZ0JBQWxCO0FBQ0EsdUJBQU8sSUFBUDtBQUNIOztBQUVELGdCQUFJLEtBQUs3RSxLQUFMLENBQVd1TCxNQUFYLENBQWtCLHVCQUFsQixFQUEyQyxLQUFLZ0MsWUFBaEQsRUFBOEQsQ0FBOUQsQ0FBSixFQUFzRTtBQUFFLHVCQUFPLEtBQVA7QUFBZTs7QUFFdkYsZ0JBQUlDLHVCQUF1QjtBQUN2QixnQ0FBZ0IsQ0FETztBQUV2QixnQ0FBZ0I7QUFGTyxhQUEzQjs7QUFLQSxnQkFBSUMsdUJBQXVCLEVBQTNCOztBQUVBLGlCQUFLLElBQUk3SixJQUFJLENBQWIsRUFBZ0JBLElBQUkySixZQUFwQixFQUFrQzNKLEdBQWxDLEVBQXVDO0FBQ25DLG9CQUFJOEosU0FBUyxLQUFLMU4sS0FBTCxDQUFXeUwsU0FBWCxFQUFiO0FBQ0Esb0JBQUlrQyxlQUFlLEtBQUszTixLQUFMLENBQVc2SyxVQUFYLENBQXNCLEVBQXRCLENBQW5CO0FBQ0E0QyxxQ0FBcUJHLElBQXJCLENBQTBCRCxZQUExQjtBQUNIOztBQUVELGlCQUFLLElBQUlFLFFBQVQsSUFBcUJMLG9CQUFyQixFQUEyQztBQUN2QyxvQkFBSUMscUJBQXFCSyxPQUFyQixDQUE2QkQsUUFBN0IsS0FBMEMsQ0FBQyxDQUEvQyxFQUFrRDtBQUM5Qyx5QkFBSzdOLEtBQUwsQ0FBVzRMLElBQVgsQ0FBZ0IsQ0FBQyxDQUFELEVBQUksQ0FBSixFQUFPLENBQVAsRUFBVTRCLHFCQUFxQkssUUFBckIsQ0FBVixDQUFoQjs7QUFFQSw0QkFBUUEsUUFBUjtBQUNJLDZCQUFLLGNBQUw7QUFBc0I7QUFDbEIsaUNBQUtoSixZQUFMLENBQWtCLGdCQUFsQjtBQUNBLG1DQUFPLElBQVA7QUFDSiw2QkFBSyxjQUFMO0FBQXFCO0FBQ2pCLGlDQUFLcEYsZ0JBQUwsR0FBd0IsQ0FBeEI7QUFDQSxtQ0FBTyxLQUFLMkcsU0FBTCxFQUFQO0FBQ0o7QUFDSSxtQ0FBTyxLQUFLdEIsS0FBTCxDQUFXLG1DQUFtQytJLFFBQTlDLENBQVA7QUFSUjtBQVVIO0FBQ0o7O0FBRUQsbUJBQU8sS0FBSy9JLEtBQUwsQ0FBVyw4QkFBWCxDQUFQO0FBQ0gsU0FqbUJXOztBQW1tQlp3SCxtQ0FBMkIsWUFBWTtBQUNuQyxvQkFBUSxLQUFLN00sZ0JBQWI7QUFDSSxxQkFBSyxDQUFMO0FBQVM7QUFDTCx3QkFBSSxLQUFLTyxLQUFMLENBQVd1TCxNQUFYLENBQWtCLGFBQWxCLEVBQWlDLENBQWpDLENBQUosRUFBeUM7QUFBRSwrQkFBTyxLQUFQO0FBQWU7QUFDMUQsd0JBQUlDLFNBQVMsS0FBS3hMLEtBQUwsQ0FBV3lMLFNBQVgsRUFBYjtBQUNBLHdCQUFJdEcsU0FBUyxLQUFLbkYsS0FBTCxDQUFXNkssVUFBWCxDQUFzQlcsTUFBdEIsQ0FBYjtBQUNBLDJCQUFPLEtBQUsxRyxLQUFMLENBQVcsbUJBQW1CSyxNQUE5QixDQUFQOztBQUVKLHFCQUFLLENBQUw7QUFBUztBQUNMLHdCQUFJLEtBQUs1RixZQUFMLElBQXFCLEdBQXpCLEVBQThCO0FBQzFCLDZCQUFLc0YsWUFBTCxDQUFrQixnQkFBbEI7QUFDQSwrQkFBTyxJQUFQO0FBQ0g7QUFDRCx5QkFBS0EsWUFBTCxDQUFrQixzQkFBbEIsRUFBMEMsa0JBQTFDO0FBQ0EsMkJBQU8sS0FBS3VCLFNBQUwsRUFBUDs7QUFFSixxQkFBSyxFQUFMO0FBQVU7QUFDTiwyQkFBTyxLQUFLeUYsbUJBQUwsRUFBUDs7QUFFSixxQkFBSyxDQUFMO0FBQVM7QUFDTCwyQkFBTyxLQUFLVSx1QkFBTCxFQUFQOztBQUVKLHFCQUFLLEVBQUw7QUFBVTtBQUNOLDJCQUFPLEtBQUtlLHFCQUFMLEVBQVA7O0FBRUo7QUFDSSwyQkFBTyxLQUFLeEksS0FBTCxDQUFXLDhCQUE4QixLQUFLckYsZ0JBQTlDLENBQVA7QUF6QlI7QUEyQkgsU0EvbkJXOztBQWlvQlpzTyxpQ0FBeUIsWUFBWTtBQUNqQyxnQkFBSSxLQUFLL04sS0FBTCxDQUFXdUwsTUFBWCxDQUFrQixvQkFBbEIsRUFBd0MsQ0FBeEMsQ0FBSixFQUFnRDtBQUFFLHVCQUFPLEtBQVA7QUFBZTtBQUNqRSxvQkFBUSxLQUFLdkwsS0FBTCxDQUFXeUwsU0FBWCxFQUFSO0FBQ0kscUJBQUssQ0FBTDtBQUFTO0FBQ0wseUJBQUs1RyxZQUFMLENBQWtCLHNCQUFsQixFQUEwQyxtQkFBMUM7QUFDQSwyQkFBTyxLQUFLdUIsU0FBTCxFQUFQO0FBQ0oscUJBQUssQ0FBTDtBQUFTO0FBQ0wsd0JBQUksS0FBSzdHLFlBQUwsSUFBcUIsR0FBekIsRUFBOEI7QUFDMUIsNEJBQUlzRSxTQUFTLEtBQUs3RCxLQUFMLENBQVd5TCxTQUFYLEVBQWI7QUFDQSw0QkFBSSxLQUFLekwsS0FBTCxDQUFXdUwsTUFBWCxDQUFrQix1QkFBbEIsRUFBMkMxSCxNQUEzQyxFQUFtRCxDQUFuRCxDQUFKLEVBQTJEO0FBQUUsbUNBQU8sS0FBUDtBQUFlO0FBQzVFLDRCQUFJc0IsU0FBUyxLQUFLbkYsS0FBTCxDQUFXNkssVUFBWCxDQUFzQmhILE1BQXRCLENBQWI7QUFDQSwrQkFBTyxLQUFLaUIsS0FBTCxDQUFXSyxNQUFYLENBQVA7QUFDSCxxQkFMRCxNQUtPO0FBQ0gsK0JBQU8sS0FBS0wsS0FBTCxDQUFXLHdCQUFYLENBQVA7QUFDSDtBQUNELDJCQUFPLEtBQVA7QUFDSixxQkFBSyxDQUFMO0FBQ0ksMkJBQU8sS0FBS0EsS0FBTCxDQUFXLHdCQUFYLENBQVA7QUFDSjtBQUNJLDJCQUFPLEtBQUtBLEtBQUwsQ0FBVyx3QkFBWCxDQUFQO0FBakJSO0FBbUJILFNBdHBCVzs7QUF3cEJaa0osZ0NBQXdCLFlBQVk7QUFDaEMsZ0JBQUksS0FBS2hPLEtBQUwsQ0FBV3VMLE1BQVgsQ0FBa0IsdUJBQWxCLEVBQTJDLEVBQTNDLENBQUosRUFBb0Q7QUFBRSx1QkFBTyxLQUFQO0FBQWU7O0FBRXJFO0FBQ0EsaUJBQUs5SixTQUFMLEdBQWtCLEtBQUt6QixLQUFMLENBQVdpTyxTQUFYLEVBQWxCO0FBQ0EsaUJBQUt2TSxVQUFMLEdBQWtCLEtBQUsxQixLQUFMLENBQVdpTyxTQUFYLEVBQWxCO0FBQ0EsaUJBQUtyTSxTQUFMLEdBQWlCLElBQUlFLFVBQUosQ0FBZSxLQUFLTCxTQUFMLEdBQWlCLEtBQUtDLFVBQXRCLEdBQW1DLENBQWxELENBQWpCOztBQUVBO0FBQ0EsZ0JBQUl3TSxNQUFjLEtBQUtsTyxLQUFMLENBQVdzTCxRQUFYLEVBQWxCO0FBQ0EsZ0JBQUk2QyxRQUFjLEtBQUtuTyxLQUFMLENBQVdzTCxRQUFYLEVBQWxCO0FBQ0EsZ0JBQUk4QyxhQUFjLEtBQUtwTyxLQUFMLENBQVdzTCxRQUFYLEVBQWxCO0FBQ0EsZ0JBQUkrQyxhQUFjLEtBQUtyTyxLQUFMLENBQVdzTCxRQUFYLEVBQWxCOztBQUVBLGdCQUFJZ0QsVUFBYyxLQUFLdE8sS0FBTCxDQUFXaU8sU0FBWCxFQUFsQjtBQUNBLGdCQUFJTSxZQUFjLEtBQUt2TyxLQUFMLENBQVdpTyxTQUFYLEVBQWxCO0FBQ0EsZ0JBQUlPLFdBQWMsS0FBS3hPLEtBQUwsQ0FBV2lPLFNBQVgsRUFBbEI7QUFDQSxnQkFBSVEsWUFBYyxLQUFLek8sS0FBTCxDQUFXc0wsUUFBWCxFQUFsQjtBQUNBLGdCQUFJb0QsY0FBYyxLQUFLMU8sS0FBTCxDQUFXc0wsUUFBWCxFQUFsQjtBQUNBLGdCQUFJcUQsYUFBYyxLQUFLM08sS0FBTCxDQUFXc0wsUUFBWCxFQUFsQjtBQUNBLGlCQUFLdEwsS0FBTCxDQUFXNE8sV0FBWCxDQUF1QixDQUF2QixFQXBCZ0MsQ0FvQko7O0FBRTVCO0FBQ0E7O0FBRUE7QUFDQSxnQkFBSUMsY0FBYyxLQUFLN08sS0FBTCxDQUFXeUwsU0FBWCxFQUFsQjtBQUNBLGdCQUFJLEtBQUt6TCxLQUFMLENBQVd1TCxNQUFYLENBQWtCLGtCQUFsQixFQUFzQ3NELFdBQXRDLEVBQW1ELEVBQW5ELENBQUosRUFBNEQ7QUFBRSx1QkFBTyxLQUFQO0FBQWU7QUFDN0UsaUJBQUtsTixRQUFMLEdBQWdCLGVBQUttTixVQUFMLENBQWdCLEtBQUs5TyxLQUFMLENBQVc2SyxVQUFYLENBQXNCZ0UsV0FBdEIsQ0FBaEIsQ0FBaEI7O0FBRUEsZ0JBQUksS0FBS25QLGFBQVQsRUFBd0I7QUFDcEIsb0JBQUksS0FBS00sS0FBTCxDQUFXdUwsTUFBWCxDQUFrQixzQ0FBbEIsRUFBMEQsQ0FBMUQsRUFBNkQsS0FBS3NELFdBQWxFLENBQUosRUFBb0Y7QUFBRSwyQkFBTyxLQUFQO0FBQWU7QUFDckc7QUFDQSxvQkFBSUUsb0JBQW9CLEtBQUsvTyxLQUFMLENBQVdpTyxTQUFYLEVBQXhCO0FBQ0Esb0JBQUllLG9CQUFvQixLQUFLaFAsS0FBTCxDQUFXaU8sU0FBWCxFQUF4QjtBQUNBLG9CQUFJZ0IsZUFBZSxLQUFLalAsS0FBTCxDQUFXaU8sU0FBWCxFQUFuQjtBQUNBLHFCQUFLak8sS0FBTCxDQUFXNE8sV0FBWCxDQUF1QixDQUF2QixFQU5vQixDQU1ROztBQUU1QixvQkFBSU0sc0JBQXNCLENBQUNILG9CQUFvQkMsaUJBQXBCLEdBQXdDQyxZQUF6QyxJQUF5RCxFQUFuRjtBQUNBLG9CQUFJLEtBQUtqUCxLQUFMLENBQVd1TCxNQUFYLENBQWtCLHNDQUFsQixFQUEwRDJELG1CQUExRCxFQUErRSxLQUFLTCxXQUFwRixDQUFKLEVBQXNHO0FBQUUsMkJBQU8sS0FBUDtBQUFlOztBQUV2SDtBQUNBOztBQUVBO0FBQ0EscUJBQUs3TyxLQUFMLENBQVc0TyxXQUFYLENBQXVCLEtBQUtHLGlCQUE1Qjs7QUFFQTtBQUNBLHFCQUFLL08sS0FBTCxDQUFXNE8sV0FBWCxDQUF1QixLQUFLSSxpQkFBNUI7O0FBRUE7QUFDQSxxQkFBS2hQLEtBQUwsQ0FBVzRPLFdBQVgsQ0FBdUIsS0FBS0ssWUFBNUI7QUFDSDs7QUFFRDtBQUNBO0FBQ0EsMkJBQUt6SixJQUFMLENBQVUsYUFBYSxLQUFLL0QsU0FBbEIsR0FBOEIsR0FBOUIsR0FBb0MsS0FBS0MsVUFBekMsR0FDQSxTQURBLEdBQ1l3TSxHQURaLEdBQ2tCLFdBRGxCLEdBQ2dDQyxLQURoQyxHQUVBLGdCQUZBLEdBRW1CQyxVQUZuQixHQUdBLGdCQUhBLEdBR21CQyxVQUhuQixHQUlBLGFBSkEsR0FJZ0JDLE9BSmhCLEdBS0EsZUFMQSxHQUtrQkMsU0FMbEIsR0FNQSxjQU5BLEdBTWlCQyxRQU5qQixHQU9BLGVBUEEsR0FPa0JDLFNBUGxCLEdBUUEsaUJBUkEsR0FRb0JDLFdBUnBCLEdBU0EsZ0JBVEEsR0FTbUJDLFVBVDdCOztBQVdBLGdCQUFJUCxlQUFlLENBQW5CLEVBQXNCO0FBQ2xCLCtCQUFLcEosSUFBTCxDQUFVLDJDQUFWO0FBQ0g7O0FBRUQsZ0JBQUl5SixjQUFjLEVBQWxCLEVBQXNCO0FBQ2xCLCtCQUFLekosSUFBTCxDQUFVLG1DQUFWO0FBQ0g7O0FBRUQsZ0JBQUkySixlQUFlLENBQW5CLEVBQXNCO0FBQ2xCLCtCQUFLM0osSUFBTCxDQUFVLG1DQUFWO0FBQ0g7O0FBRUQ7QUFDQSxpQkFBS21LLGNBQUwsQ0FBb0IsSUFBcEIsRUFBMEIsS0FBS3hOLFFBQS9COztBQUVBLGdCQUFJLEtBQUt5TixXQUFMLElBQW9CLEtBQUt6TixRQUFMLEtBQWtCLGtCQUExQyxFQUE4RDtBQUMxRCwrQkFBS3FELElBQUwsQ0FBVSxvRUFBVjtBQUNBLHFCQUFLb0ssV0FBTCxHQUFtQixLQUFuQjtBQUNIOztBQUVELGlCQUFLblAsUUFBTCxDQUFjb1AsY0FBZCxDQUE2QixLQUFLRCxXQUFsQztBQUNBLGlCQUFLblAsUUFBTCxDQUFjcVAsTUFBZCxDQUFxQixLQUFLN04sU0FBMUIsRUFBcUMsS0FBS0MsVUFBMUM7QUFDQSxpQkFBSzZOLFdBQUwsQ0FBaUIsSUFBakIsRUFBdUIsS0FBSzlOLFNBQTVCLEVBQXVDLEtBQUtDLFVBQTVDO0FBQ0EsaUJBQUt4QixTQUFMLENBQWVzUCxJQUFmO0FBQ0EsaUJBQUtyUCxNQUFMLENBQVlxUCxJQUFaOztBQUVBLGdCQUFJLEtBQUtKLFdBQVQsRUFBc0I7QUFDbEIscUJBQUs3TixPQUFMLEdBQWUsQ0FBZjtBQUNBLHFCQUFLQyxTQUFMLEdBQWlCLENBQWpCO0FBQ0gsYUFIRCxNQUdPO0FBQ0gscUJBQUtELE9BQUwsR0FBZSxDQUFmO0FBQ0EscUJBQUtDLFNBQUwsR0FBaUIsQ0FBakI7QUFDSDs7QUFFRHhDLGdCQUFJdUgsUUFBSixDQUFha0osV0FBYixDQUF5QixLQUFLelAsS0FBOUIsRUFBcUMsS0FBS3VCLE9BQTFDLEVBQW1ELEtBQUtDLFNBQXhELEVBQW1FLEtBQUs0TixXQUF4RTtBQUNBcFEsZ0JBQUl1SCxRQUFKLENBQWFtSixlQUFiLENBQTZCLEtBQUsxUCxLQUFsQyxFQUF5QyxLQUFLSixVQUE5QyxFQUEwRCxLQUFLK1AsYUFBL0QsRUFBOEUsS0FBS1AsV0FBbkY7QUFDQXBRLGdCQUFJdUgsUUFBSixDQUFhcUosZ0JBQWIsQ0FBOEIsS0FBSzVQLEtBQW5DLEVBQTBDLEtBQTFDLEVBQWlELEtBQUtDLFFBQUwsQ0FBYzRQLGtCQUFkLEVBQWpELEVBQXFGLEtBQUtwTyxTQUExRixFQUFxRyxLQUFLQyxVQUExRzs7QUFFQSxpQkFBS00sT0FBTCxDQUFhTSxZQUFiLEdBQTZCLElBQUl3TixJQUFKLEVBQUQsQ0FBYUMsT0FBYixFQUE1QjtBQUNBLGlCQUFLL04sT0FBTCxDQUFhUyxNQUFiLEdBQXNCLENBQXRCOztBQUVBLGdCQUFJLEtBQUt1RixRQUFULEVBQW1CO0FBQ2YscUJBQUtuRCxZQUFMLENBQWtCLFFBQWxCLEVBQTRCLCtCQUErQixLQUFLbEQsUUFBaEU7QUFDSCxhQUZELE1BRU87QUFDSCxxQkFBS2tELFlBQUwsQ0FBa0IsUUFBbEIsRUFBNEIsaUNBQWlDLEtBQUtsRCxRQUFsRTtBQUNIO0FBQ0QsbUJBQU8sSUFBUDtBQUNILFNBMXdCVzs7QUE0d0JaeUUsbUJBQVcsWUFBWTtBQUNuQixvQkFBUSxLQUFLOUcsVUFBYjtBQUNJLHFCQUFLLGlCQUFMO0FBQ0ksMkJBQU8sS0FBS3FMLDJCQUFMLEVBQVA7O0FBRUoscUJBQUssVUFBTDtBQUNJLDJCQUFPLEtBQUtTLG1CQUFMLEVBQVA7O0FBRUoscUJBQUssZ0JBQUw7QUFDSSwyQkFBTyxLQUFLa0IseUJBQUwsRUFBUDs7QUFFSixxQkFBSyxnQkFBTDtBQUNJLDJCQUFPLEtBQUt5Qix1QkFBTCxFQUFQOztBQUVKLHFCQUFLLHNCQUFMO0FBQ0kseUJBQUsvTixLQUFMLENBQVc0TCxJQUFYLENBQWdCLENBQUMsS0FBS29FLE9BQUwsR0FBZSxDQUFmLEdBQW1CLENBQXBCLENBQWhCLEVBREosQ0FDNkM7QUFDekMseUJBQUtuTCxZQUFMLENBQWtCLHNCQUFsQixFQUEwQyxtQkFBMUM7QUFDQSwyQkFBTyxJQUFQOztBQUVKLHFCQUFLLHNCQUFMO0FBQ0ksMkJBQU8sS0FBS21KLHNCQUFMLEVBQVA7O0FBRUo7QUFDSSwyQkFBTyxLQUFLbEosS0FBTCxDQUFXLG9CQUFvQixLQUFLeEYsVUFBcEMsQ0FBUDtBQXRCUjtBQXdCSCxTQXJ5Qlc7O0FBdXlCWjJRLG9DQUE0QixZQUFZO0FBQ3BDLDJCQUFLNU0sS0FBTCxDQUFXLG9CQUFYO0FBQ0EsaUJBQUtyRCxLQUFMLENBQVdrUSxPQUFYLEdBRm9DLENBRWI7O0FBRXZCLGdCQUFJQyxlQUFlLEtBQUtuUSxLQUFMLENBQVdpTyxTQUFYLEVBQW5CO0FBQ0EsZ0JBQUltQyxjQUFjLEtBQUtwUSxLQUFMLENBQVdpTyxTQUFYLEVBQWxCO0FBQ0EsZ0JBQUksS0FBS2pPLEtBQUwsQ0FBV3VMLE1BQVgsQ0FBa0Isb0JBQWxCLEVBQXdDNkUsY0FBYyxDQUF0RCxFQUF5RCxDQUF6RCxDQUFKLEVBQWlFO0FBQUUsdUJBQU8sS0FBUDtBQUFlOztBQUVsRixpQkFBSyxJQUFJQyxJQUFJLENBQWIsRUFBZ0JBLElBQUlELFdBQXBCLEVBQWlDQyxHQUFqQyxFQUFzQztBQUNsQyxvQkFBSUMsTUFBTW5GLFNBQVMsS0FBS25MLEtBQUwsQ0FBV2lPLFNBQVgsS0FBeUIsR0FBbEMsRUFBdUMsRUFBdkMsQ0FBVjtBQUNBLG9CQUFJc0MsUUFBUXBGLFNBQVMsS0FBS25MLEtBQUwsQ0FBV2lPLFNBQVgsS0FBeUIsR0FBbEMsRUFBdUMsRUFBdkMsQ0FBWjtBQUNBLG9CQUFJdUMsT0FBT3JGLFNBQVMsS0FBS25MLEtBQUwsQ0FBV2lPLFNBQVgsS0FBeUIsR0FBbEMsRUFBdUMsRUFBdkMsQ0FBWDtBQUNBLHFCQUFLaE8sUUFBTCxDQUFjd1EsYUFBZCxDQUE0QixDQUFDRCxJQUFELEVBQU9ELEtBQVAsRUFBY0QsR0FBZCxDQUE1QixFQUFnREgsZUFBZUUsQ0FBL0Q7QUFDSDtBQUNELDJCQUFLaE4sS0FBTCxDQUFXLGdCQUFnQixLQUFLcEQsUUFBTCxDQUFjeVEsYUFBZCxFQUEzQjtBQUNBLDJCQUFLbEwsSUFBTCxDQUFVLGdCQUFnQjRLLFdBQWhCLEdBQThCLG9CQUF4Qzs7QUFFQSxtQkFBTyxJQUFQO0FBQ0gsU0F6ekJXOztBQTJ6QlpPLGlDQUF5QixZQUFZO0FBQ2pDLDJCQUFLdE4sS0FBTCxDQUFXLGVBQVg7QUFDQSxnQkFBSSxLQUFLckQsS0FBTCxDQUFXdUwsTUFBWCxDQUFrQixzQkFBbEIsRUFBMEMsQ0FBMUMsRUFBNkMsQ0FBN0MsQ0FBSixFQUFxRDtBQUFFLHVCQUFPLEtBQVA7QUFBZTtBQUN0RSxpQkFBS3ZMLEtBQUwsQ0FBVzRPLFdBQVgsQ0FBdUIsQ0FBdkIsRUFIaUMsQ0FHTDtBQUM1QixnQkFBSS9LLFNBQVMsS0FBSzdELEtBQUwsQ0FBV3lMLFNBQVgsRUFBYjtBQUNBLGdCQUFJLEtBQUt6TCxLQUFMLENBQVd1TCxNQUFYLENBQWtCLGVBQWxCLEVBQW1DMUgsTUFBbkMsRUFBMkMsQ0FBM0MsQ0FBSixFQUFtRDtBQUFFLHVCQUFPLEtBQVA7QUFBZTs7QUFFcEUsZ0JBQUkyRCxPQUFPLEtBQUt4SCxLQUFMLENBQVc2SyxVQUFYLENBQXNCaEgsTUFBdEIsQ0FBWDtBQUNBLGlCQUFLK00sWUFBTCxDQUFrQixJQUFsQixFQUF3QnBKLElBQXhCOztBQUVBLG1CQUFPLElBQVA7QUFDSCxTQXQwQlc7O0FBdzBCWnFKLGtDQUEwQixZQUFXO0FBQ2pDLGdCQUFJLEtBQUs3USxLQUFMLENBQVd1TCxNQUFYLENBQWtCLG9CQUFsQixFQUF3QyxDQUF4QyxFQUEyQyxDQUEzQyxDQUFKLEVBQW1EO0FBQUUsdUJBQU8sS0FBUDtBQUFlO0FBQ3BFLGlCQUFLdkwsS0FBTCxDQUFXNE8sV0FBWCxDQUF1QixDQUF2QixFQUZpQyxDQUVOO0FBQzNCLGdCQUFJa0MsUUFBUSxLQUFLOVEsS0FBTCxDQUFXeUwsU0FBWCxFQUFaO0FBQ0EsZ0JBQUk1SCxTQUFTLEtBQUs3RCxLQUFMLENBQVdzTCxRQUFYLEVBQWI7O0FBRUEsZ0JBQUksS0FBS3RMLEtBQUwsQ0FBV3VMLE1BQVgsQ0FBa0IscUJBQWxCLEVBQXlDMUgsTUFBekMsRUFBaUQsQ0FBakQsQ0FBSixFQUF5RDtBQUFFLHVCQUFPLEtBQVA7QUFBZTs7QUFFMUUsZ0JBQUlBLFNBQVMsRUFBYixFQUFpQjtBQUNiLCtCQUFLbUIsSUFBTCxDQUFVLHlCQUF5Qm5CLE1BQXpCLEdBQWtDLHFCQUE1QztBQUNBQSx5QkFBUyxFQUFUO0FBQ0g7O0FBRUQsZ0JBQUlrTixVQUFVLEtBQUsvUSxLQUFMLENBQVc2SyxVQUFYLENBQXNCaEgsTUFBdEIsQ0FBZDs7QUFFQSxpQkFBS3ZELGNBQUwsR0FBc0IsSUFBdEI7O0FBRUE7Ozs7Ozs7OztBQVNBLGdCQUFJLEVBQUV3USxRQUFTLEtBQUcsRUFBZCxDQUFKLEVBQXdCO0FBQ3BCLHVCQUFPLEtBQUtoTSxLQUFMLENBQVcsMkJBQVgsQ0FBUDtBQUNIOztBQUVEO0FBQ0E7QUFDQWdNLHFCQUFVLEtBQUcsQ0FBSixHQUFVLEtBQUcsQ0FBdEI7O0FBRUE7QUFDQTtBQUNBO0FBQ0E5UixnQkFBSXVILFFBQUosQ0FBYXlLLFdBQWIsQ0FBeUIsS0FBS2hSLEtBQTlCLEVBQXFDOFEsS0FBckMsRUFBNENDLE9BQTVDOztBQUVBLG1CQUFPLElBQVA7QUFDSCxTQWgzQlc7O0FBazNCWkUseUJBQWlCLFlBQVk7QUFDekIsZ0JBQUksS0FBS2pSLEtBQUwsQ0FBV3VMLE1BQVgsQ0FBa0IseUJBQWxCLEVBQTZDLENBQTdDLEVBQWdELENBQWhELENBQUosRUFBd0Q7QUFBRSx1QkFBTyxLQUFQO0FBQWU7QUFDekUsaUJBQUt2TCxLQUFMLENBQVdrUSxPQUFYLEdBRnlCLENBRUY7QUFDdkIsZ0JBQUlnQixVQUFVLEtBQUtsUixLQUFMLENBQVdzTCxRQUFYLEVBQWQ7QUFDQSxnQkFBSTZGLFVBQVUsS0FBS25SLEtBQUwsQ0FBV3NMLFFBQVgsRUFBZDs7QUFFQSxvQkFBUTZGLE9BQVI7QUFDSSxxQkFBSyxDQUFMO0FBQVM7QUFDTCx5QkFBS3RNLFlBQUwsQ0FBa0IsS0FBS3ZGLFVBQXZCLEVBQW1DLGtCQUFuQztBQUNBO0FBQ0oscUJBQUssQ0FBTDtBQUFTO0FBQ0wseUJBQUtLLFlBQUwsR0FBb0J1UixPQUFwQjtBQUNBLG1DQUFLMUwsSUFBTCxDQUFVLHFDQUFxQyxLQUFLN0YsWUFBMUMsR0FBeUQsR0FBbkU7QUFDQSx5QkFBS3lSLFVBQUwsQ0FBZ0IsS0FBS3pSLFlBQXJCO0FBQ0E7QUFDSjtBQUNJLHlCQUFLbUYsS0FBTCxDQUFXLDhDQUE4Q3FNLE9BQXpEO0FBQ0E7QUFYUjs7QUFjQSxtQkFBTyxJQUFQO0FBQ0gsU0F2NEJXOztBQXk0QlozSCxxQkFBYSxZQUFZO0FBQ3JCLGdCQUFJNkgsUUFBSjs7QUFFQSxnQkFBSSxLQUFLNVEsSUFBTCxDQUFVQyxLQUFWLEdBQWtCLENBQXRCLEVBQXlCO0FBQ3JCMlEsMkJBQVcsQ0FBWDtBQUNILGFBRkQsTUFFTztBQUNIQSwyQkFBVyxLQUFLclIsS0FBTCxDQUFXc0wsUUFBWCxFQUFYO0FBQ0g7O0FBRUQsb0JBQVErRixRQUFSO0FBQ0kscUJBQUssQ0FBTDtBQUFTO0FBQ0wsd0JBQUlDLE1BQU0sS0FBS0Msa0JBQUwsRUFBVjtBQUNBLHdCQUFJRCxHQUFKLEVBQVM7QUFDTHRTLDRCQUFJdUgsUUFBSixDQUFhcUosZ0JBQWIsQ0FBOEIsS0FBSzVQLEtBQW5DLEVBQzhCLEtBQUtRLHlCQURuQyxFQUU4QixLQUFLUCxRQUFMLENBQWM0UCxrQkFBZCxFQUY5QixFQUc4QixLQUFLcE8sU0FIbkMsRUFHOEMsS0FBS0MsVUFIbkQ7QUFJSDtBQUNELDJCQUFPNFAsR0FBUDs7QUFFSixxQkFBSyxDQUFMO0FBQVM7QUFDTCwyQkFBTyxLQUFLckIsMEJBQUwsRUFBUDs7QUFFSixxQkFBSyxDQUFMO0FBQVM7QUFDTCxtQ0FBSzVNLEtBQUwsQ0FBVyxNQUFYO0FBQ0EseUJBQUttTyxPQUFMLENBQWEsSUFBYjtBQUNBLDJCQUFPLElBQVA7O0FBRUoscUJBQUssQ0FBTDtBQUFTO0FBQ0wsMkJBQU8sS0FBS2IsdUJBQUwsRUFBUDs7QUFFSixxQkFBSyxHQUFMO0FBQVU7QUFDTix3QkFBSWMsUUFBUSxDQUFFLEtBQUtsUiwwQkFBbkI7QUFDQSx5QkFBS0EsMEJBQUwsR0FBa0MsSUFBbEM7QUFDQSx5QkFBS0MseUJBQUwsR0FBaUMsS0FBakM7QUFDQSx3QkFBSWlSLEtBQUosRUFBVztBQUNQLDZCQUFLalIseUJBQUwsR0FBaUMsSUFBakM7QUFDQSw2QkFBS2tSLHdCQUFMO0FBQ0EsdUNBQUtsTSxJQUFMLENBQVUsOEJBQVY7QUFDSCxxQkFKRCxNQUlPO0FBQ0g7QUFDQTtBQUNIO0FBQ0QsMkJBQU8sSUFBUDs7QUFFSixxQkFBSyxHQUFMO0FBQVU7QUFDTiwyQkFBTyxLQUFLcUwsd0JBQUwsRUFBUDs7QUFFSixxQkFBSyxHQUFMO0FBQVc7QUFDUCwyQkFBTyxLQUFLSSxlQUFMLEVBQVA7O0FBRUo7QUFDSSx5QkFBS25NLEtBQUwsQ0FBVywrQ0FBK0N1TSxRQUExRDtBQUNBLG1DQUFLaE8sS0FBTCxDQUFXLDBCQUEwQixLQUFLckQsS0FBTCxDQUFXMlIsT0FBWCxDQUFtQixDQUFuQixFQUFzQixFQUF0QixDQUFyQztBQUNBLDJCQUFPLElBQVA7QUE3Q1I7QUErQ0gsU0FqOEJXOztBQW04QlpKLDRCQUFvQixZQUFZO0FBQzVCLGdCQUFJRCxNQUFNLElBQVY7QUFDQSxnQkFBSU0sR0FBSjs7QUFFQSxnQkFBSSxLQUFLblIsSUFBTCxDQUFVQyxLQUFWLEtBQW9CLENBQXhCLEVBQTJCO0FBQ3ZCLG9CQUFJLEtBQUtWLEtBQUwsQ0FBV3VMLE1BQVgsQ0FBa0IsWUFBbEIsRUFBZ0MsQ0FBaEMsRUFBbUMsQ0FBbkMsQ0FBSixFQUEyQztBQUFFLDJCQUFPLEtBQVA7QUFBZTtBQUM1RCxxQkFBS3ZMLEtBQUwsQ0FBV2tRLE9BQVgsR0FGdUIsQ0FFQTtBQUN2QixxQkFBS3pQLElBQUwsQ0FBVUMsS0FBVixHQUFrQixLQUFLVixLQUFMLENBQVdpTyxTQUFYLEVBQWxCO0FBQ0EscUJBQUt4TixJQUFMLENBQVVLLEtBQVYsR0FBa0IsQ0FBbEI7QUFDQSxxQkFBS2tCLE9BQUwsQ0FBYTZQLE9BQWIsR0FBdUIsQ0FBdkI7QUFDQSxvQkFBSSxLQUFLN1AsT0FBTCxDQUFhTSxZQUFiLEdBQTRCLENBQWhDLEVBQW1DO0FBQy9Cc1AsMEJBQU8sSUFBSTlCLElBQUosRUFBRCxDQUFhQyxPQUFiLEVBQU47QUFDQSxtQ0FBS3ZLLElBQUwsQ0FBVSx5QkFBeUJvTSxNQUFNLEtBQUs1UCxPQUFMLENBQWFNLFlBQTVDLENBQVY7QUFDSDtBQUNKOztBQUVELG1CQUFPLEtBQUs3QixJQUFMLENBQVVDLEtBQVYsR0FBa0IsQ0FBekIsRUFBNEI7QUFDeEIsb0JBQUksS0FBS3BCLFVBQUwsS0FBb0IsUUFBeEIsRUFBa0M7QUFBRSwyQkFBTyxLQUFQO0FBQWU7O0FBRW5ELG9CQUFJLEtBQUtVLEtBQUwsQ0FBV3VMLE1BQVgsQ0FBa0IsS0FBbEIsRUFBeUIsS0FBSzlLLElBQUwsQ0FBVUssS0FBbkMsQ0FBSixFQUErQztBQUFFLDJCQUFPLEtBQVA7QUFBZTtBQUNoRSxvQkFBSSxLQUFLTCxJQUFMLENBQVVLLEtBQVYsS0FBb0IsQ0FBeEIsRUFBMkI7QUFDdkIsd0JBQUksS0FBS2QsS0FBTCxDQUFXdUwsTUFBWCxDQUFrQixhQUFsQixFQUFpQyxFQUFqQyxDQUFKLEVBQTBDO0FBQUUsK0JBQU8sS0FBUDtBQUFlO0FBQzNEOztBQUVBLHdCQUFJdUcsTUFBTSxLQUFLOVIsS0FBTCxDQUFXMkwsWUFBWCxDQUF3QixFQUF4QixDQUFWO0FBQ0EseUJBQUtsTCxJQUFMLENBQVVNLENBQVYsR0FBcUIsQ0FBQytRLElBQUksQ0FBSixLQUFVLENBQVgsSUFBZ0JBLElBQUksQ0FBSixDQUFyQztBQUNBLHlCQUFLclIsSUFBTCxDQUFVTyxDQUFWLEdBQXFCLENBQUM4USxJQUFJLENBQUosS0FBVSxDQUFYLElBQWdCQSxJQUFJLENBQUosQ0FBckM7QUFDQSx5QkFBS3JSLElBQUwsQ0FBVVEsS0FBVixHQUFxQixDQUFDNlEsSUFBSSxDQUFKLEtBQVUsQ0FBWCxJQUFnQkEsSUFBSSxDQUFKLENBQXJDO0FBQ0EseUJBQUtyUixJQUFMLENBQVVTLE1BQVYsR0FBcUIsQ0FBQzRRLElBQUksQ0FBSixLQUFVLENBQVgsSUFBZ0JBLElBQUksQ0FBSixDQUFyQztBQUNBLHlCQUFLclIsSUFBTCxDQUFVVSxRQUFWLEdBQXFCZ0ssU0FBUyxDQUFDMkcsSUFBSSxDQUFKLEtBQVUsRUFBWCxLQUFrQkEsSUFBSSxDQUFKLEtBQVUsRUFBNUIsS0FDQ0EsSUFBSSxFQUFKLEtBQVcsQ0FEWixJQUNpQkEsSUFBSSxFQUFKLENBRDFCLEVBQ21DLEVBRG5DLENBQXJCOztBQUdBLHlCQUFLQyxhQUFMLENBQW1CLElBQW5CLEVBQ0ksRUFBQyxLQUFLLEtBQUt0UixJQUFMLENBQVVNLENBQWhCLEVBQW1CLEtBQUssS0FBS04sSUFBTCxDQUFVTyxDQUFsQztBQUNDLGlDQUFTLEtBQUtQLElBQUwsQ0FBVVEsS0FEcEIsRUFDMkIsVUFBVSxLQUFLUixJQUFMLENBQVVTLE1BRC9DO0FBRUMsb0NBQVksS0FBS1QsSUFBTCxDQUFVVSxRQUZ2QjtBQUdDLHdDQUFnQixLQUFLckIsU0FBTCxDQUFlLEtBQUtXLElBQUwsQ0FBVVUsUUFBekIsQ0FIakIsRUFESjs7QUFNQSx3QkFBSSxDQUFDLEtBQUtyQixTQUFMLENBQWUsS0FBS1csSUFBTCxDQUFVVSxRQUF6QixDQUFMLEVBQXlDO0FBQ3JDLDZCQUFLMkQsS0FBTCxDQUFXLHdDQUNBLEtBQUtyRSxJQUFMLENBQVVVLFFBRHJCO0FBRUEsK0JBQU8sS0FBUDtBQUNIO0FBQ0o7O0FBRUQscUJBQUthLE9BQUwsQ0FBYUMsUUFBYixHQUF5QixJQUFJNk4sSUFBSixFQUFELENBQWFDLE9BQWIsRUFBeEI7O0FBRUF1QixzQkFBTSxLQUFLelIsWUFBTCxDQUFrQixLQUFLWSxJQUFMLENBQVVVLFFBQTVCLEdBQU47O0FBRUF5USxzQkFBTyxJQUFJOUIsSUFBSixFQUFELENBQWFDLE9BQWIsRUFBTjtBQUNBLHFCQUFLL04sT0FBTCxDQUFhNlAsT0FBYixJQUF5QkQsTUFBTSxLQUFLNVAsT0FBTCxDQUFhQyxRQUE1Qzs7QUFFQSxvQkFBSXFQLEdBQUosRUFBUztBQUNMLHlCQUFLdlIsU0FBTCxDQUFlLEtBQUtVLElBQUwsQ0FBVVUsUUFBekIsRUFBbUMsQ0FBbkM7QUFDQSx5QkFBS3BCLFNBQUwsQ0FBZSxLQUFLVSxJQUFMLENBQVVVLFFBQXpCLEVBQW1DLENBQW5DO0FBQ0EseUJBQUthLE9BQUwsQ0FBYVMsTUFBYixJQUF1QixLQUFLaEMsSUFBTCxDQUFVUSxLQUFWLEdBQWtCLEtBQUtSLElBQUwsQ0FBVVMsTUFBbkQ7QUFDSDs7QUFFRCxvQkFBSSxLQUFLYyxPQUFMLENBQWFTLE1BQWIsSUFBd0IsS0FBS2hCLFNBQUwsR0FBaUIsS0FBS0MsVUFBbEQsRUFBK0Q7QUFDM0Qsd0JBQUssS0FBS2pCLElBQUwsQ0FBVVEsS0FBVixLQUFvQixLQUFLUSxTQUF6QixJQUFzQyxLQUFLaEIsSUFBTCxDQUFVUyxNQUFWLEtBQXFCLEtBQUtRLFVBQWpFLElBQ0EsS0FBS00sT0FBTCxDQUFhTSxZQUFiLEdBQTRCLENBRGhDLEVBQ21DO0FBQy9CLDZCQUFLTixPQUFMLENBQWFJLGNBQWIsSUFBK0IsS0FBS0osT0FBTCxDQUFhNlAsT0FBNUM7QUFDQSw2QkFBSzdQLE9BQUwsQ0FBYUssWUFBYjtBQUNBLHVDQUFLbUQsSUFBTCxDQUFVLCtCQUNBLEtBQUt4RCxPQUFMLENBQWE2UCxPQURiLEdBQ3VCLFdBRHZCLEdBRUEsS0FBSzdQLE9BQUwsQ0FBYUksY0FGYixHQUU4QixTQUY5QixHQUdBLEtBQUtKLE9BQUwsQ0FBYUssWUFIYixHQUc0QixTQUg1QixHQUlDLEtBQUtMLE9BQUwsQ0FBYUksY0FBYixHQUE4QixLQUFLSixPQUFMLENBQWFLLFlBSnREO0FBS0g7O0FBRUQsd0JBQUksS0FBS0wsT0FBTCxDQUFhTSxZQUFiLEdBQTRCLENBQWhDLEVBQW1DO0FBQy9CLDRCQUFJMFAsY0FBY0osTUFBTSxLQUFLNVAsT0FBTCxDQUFhTSxZQUFyQztBQUNBLDZCQUFLTixPQUFMLENBQWFPLFlBQWIsSUFBNkJ5UCxXQUE3QjtBQUNBLDZCQUFLaFEsT0FBTCxDQUFhUSxVQUFiO0FBQ0EsdUNBQUtnRCxJQUFMLENBQVUsK0JBQ0F3TSxXQURBLEdBQ2MsV0FEZCxHQUVBLEtBQUtoUSxPQUFMLENBQWFPLFlBRmIsR0FFNEIsU0FGNUIsR0FHQSxLQUFLUCxPQUFMLENBQWFRLFVBSGIsR0FHMEIsU0FIMUIsR0FJQyxLQUFLUixPQUFMLENBQWFPLFlBQWIsR0FBNEIsS0FBS1AsT0FBTCxDQUFhUSxVQUpwRDtBQUtBLDZCQUFLUixPQUFMLENBQWFNLFlBQWIsR0FBNEIsQ0FBNUI7QUFDSDtBQUNKOztBQUVELG9CQUFJLENBQUNnUCxHQUFMLEVBQVU7QUFBRSwyQkFBT0EsR0FBUDtBQUFhLGlCQW5FRCxDQW1FRztBQUM5Qjs7QUFFRCxpQkFBS1csY0FBTCxDQUFvQixJQUFwQixFQUNRLEVBQUMsS0FBSyxLQUFLeFIsSUFBTCxDQUFVTSxDQUFoQixFQUFtQixLQUFLLEtBQUtOLElBQUwsQ0FBVU8sQ0FBbEM7QUFDQyx5QkFBUyxLQUFLUCxJQUFMLENBQVVRLEtBRHBCLEVBQzJCLFVBQVUsS0FBS1IsSUFBTCxDQUFVUyxNQUQvQztBQUVDLDRCQUFZLEtBQUtULElBQUwsQ0FBVVUsUUFGdkI7QUFHQyxnQ0FBZ0IsS0FBS3JCLFNBQUwsQ0FBZSxLQUFLVyxJQUFMLENBQVVVLFFBQXpCLENBSGpCLEVBRFI7O0FBTUEsbUJBQU8sSUFBUCxDQTVGNEIsQ0E0RmQ7QUFDakIsU0FoaUNXOztBQWtpQ1p1USxrQ0FBMEIsWUFBVztBQUNqQyxnQkFBSSxDQUFDLEtBQUtsUix5QkFBVixFQUFxQztBQUFFO0FBQVM7O0FBRWhEeEIsZ0JBQUl1SCxRQUFKLENBQWEyTCx1QkFBYixDQUFxQyxLQUFLbFMsS0FBMUMsRUFBaUQsSUFBakQsRUFBdUQsQ0FBdkQsRUFBMEQsQ0FBMUQsRUFDcUMsS0FBS3lCLFNBRDFDLEVBQ3FELEtBQUtDLFVBRDFEO0FBRUg7QUF2aUNXLEtBQWhCOztBQTBpQ0EsbUJBQUt5USxlQUFMLENBQXFCblQsR0FBckIsRUFBMEIsQ0FDdEIsQ0FBQyxRQUFELEVBQVcsSUFBWCxFQUFpQixLQUFqQixDQURzQixFQUNrQjtBQUN4QyxLQUFDLGdCQUFELEVBQW1CLElBQW5CLEVBQXlCLEtBQXpCLENBRnNCLEVBRWtCO0FBQ3hDLEtBQUMsU0FBRCxFQUFZLElBQVosRUFBa0IsTUFBbEIsQ0FIc0IsRUFHa0I7QUFDeEMsS0FBQyxZQUFELEVBQWUsSUFBZixFQUFxQixNQUFyQixDQUpzQixFQUlrQjtBQUN4QyxLQUFDLGNBQUQsRUFBaUIsSUFBakIsRUFBdUIsTUFBdkIsQ0FMc0IsRUFLa0I7QUFDeEMsS0FBQyxRQUFELEVBQVcsSUFBWCxFQUFpQixNQUFqQixDQU5zQixFQU1rQjtBQUN4QyxLQUFDLFdBQUQsRUFBYyxJQUFkLEVBQW9CLE1BQXBCLENBUHNCLEVBT2tCO0FBQ3hDLEtBQUMsa0JBQUQsRUFBcUIsSUFBckIsRUFBMkIsS0FBM0IsQ0FSc0IsRUFRa0I7QUFDeEMsS0FBQyxtQkFBRCxFQUFzQixJQUF0QixFQUE0QixLQUE1QixDQVRzQixFQVNrQjtBQUN4QyxLQUFDLGFBQUQsRUFBZ0IsSUFBaEIsRUFBc0IsS0FBdEIsQ0FWc0IsRUFVa0I7QUFDeEMsS0FBQyxZQUFELEVBQWUsSUFBZixFQUFxQixLQUFyQixDQVhzQixFQVdrQjtBQUN4QyxLQUFDLGNBQUQsRUFBaUIsSUFBakIsRUFBdUIsTUFBdkIsQ0Fac0IsRUFZa0I7O0FBRXhDO0FBQ0EsS0FBQyxlQUFELEVBQWtCLElBQWxCLEVBQXdCLE1BQXhCLENBZnNCLEVBZWtCO0FBQ3hDLEtBQUMsb0JBQUQsRUFBdUIsSUFBdkIsRUFBNkIsTUFBN0IsQ0FoQnNCLEVBZ0JrQjtBQUN4QyxLQUFDLGFBQUQsRUFBZ0IsSUFBaEIsRUFBc0IsTUFBdEIsQ0FqQnNCLEVBaUJrQjtBQUN4QyxLQUFDLFFBQUQsRUFBVyxJQUFYLEVBQWlCLE1BQWpCLENBbEJzQixFQWtCa0I7QUFDeEMsS0FBQyxjQUFELEVBQWlCLElBQWpCLEVBQXVCLE1BQXZCLENBbkJzQixFQW1Ca0I7QUFDeEMsS0FBQyxlQUFELEVBQWtCLElBQWxCLEVBQXdCLE1BQXhCLENBcEJzQixFQW9Ca0I7QUFDeEMsS0FBQyxZQUFELEVBQWUsSUFBZixFQUFxQixNQUFyQixDQXJCc0IsRUFxQmtCO0FBQ3hDLEtBQUMsZUFBRCxFQUFrQixJQUFsQixFQUF3QixNQUF4QixDQXRCc0IsRUFzQmtCO0FBQ3hDLEtBQUMsV0FBRCxFQUFjLElBQWQsRUFBb0IsTUFBcEIsQ0F2QnNCLENBdUJrQjtBQXZCbEIsS0FBMUI7O0FBMEJBQSxRQUFJeUcsU0FBSixDQUFjMk0sZ0JBQWQsR0FBaUMsVUFBVUMsTUFBVixFQUFrQjtBQUMvQyxZQUFJLENBQUNBLE1BQUQsSUFBWUEsVUFBVSxFQUFDLEtBQUssQ0FBTixFQUFTLE1BQU0sQ0FBZixFQUFrQixTQUFTLENBQTNCLEVBQTFCLEVBQTBEO0FBQ3RELGlCQUFLMUMsYUFBTCxHQUFxQixLQUFyQjtBQUNBLGlCQUFLMVAsUUFBTCxDQUFjcVMsa0JBQWQsR0FGc0QsQ0FFbEI7QUFDdkMsU0FIRCxNQUdPO0FBQ0gsZ0JBQUksS0FBS3JTLFFBQUwsQ0FBY3NTLGNBQWQsRUFBSixFQUFvQztBQUNoQyxxQkFBSzVDLGFBQUwsR0FBcUIsSUFBckI7QUFDSCxhQUZELE1BRU87QUFDSCwrQkFBSzNLLElBQUwsQ0FBVSx1Q0FBVjtBQUNBLHFCQUFLL0UsUUFBTCxDQUFjcVMsa0JBQWQ7QUFDSDtBQUNKO0FBQ0osS0FaRDs7QUFjQXRULFFBQUl5RyxTQUFKLENBQWMrTSxXQUFkLEdBQTRCLFlBQVk7QUFBRSxlQUFPLEtBQUt2UyxRQUFaO0FBQXVCLEtBQWpFO0FBQ0FqQixRQUFJeUcsU0FBSixDQUFjZ04sWUFBZCxHQUE2QixZQUFZO0FBQUUsZUFBTyxLQUFLdlMsU0FBWjtBQUF3QixLQUFuRTtBQUNBbEIsUUFBSXlHLFNBQUosQ0FBY2lOLFNBQWQsR0FBMEIsWUFBWTtBQUFFLGVBQU8sS0FBS3ZTLE1BQVo7QUFBcUIsS0FBN0Q7O0FBRUE7QUFDQW5CLFFBQUl1SCxRQUFKLEdBQWU7QUFDWEMsa0JBQVUsVUFBVW1NLElBQVYsRUFBZ0IvSSxNQUFoQixFQUF3QnRDLElBQXhCLEVBQThCO0FBQ3BDLGdCQUFJc0wsT0FBT0QsS0FBS0UsR0FBaEI7QUFDQSxnQkFBSUMsU0FBU0gsS0FBS0ksTUFBbEI7O0FBRUFILGlCQUFLRSxNQUFMLElBQWUsQ0FBZixDQUpvQyxDQUlqQjtBQUNuQkYsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQnhMLElBQW5COztBQUVBc0wsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQixDQUFuQjtBQUNBRixpQkFBS0UsU0FBUyxDQUFkLElBQW1CLENBQW5COztBQUVBRixpQkFBS0UsU0FBUyxDQUFkLElBQW9CbEosVUFBVSxFQUE5QjtBQUNBZ0osaUJBQUtFLFNBQVMsQ0FBZCxJQUFvQmxKLFVBQVUsRUFBOUI7QUFDQWdKLGlCQUFLRSxTQUFTLENBQWQsSUFBb0JsSixVQUFVLENBQTlCO0FBQ0FnSixpQkFBS0UsU0FBUyxDQUFkLElBQW1CbEosTUFBbkI7O0FBRUErSSxpQkFBS0ksTUFBTCxJQUFlLENBQWY7QUFDQUosaUJBQUsvSyxLQUFMO0FBQ0gsU0FsQlU7O0FBb0JYaUMsOEJBQXNCLFVBQVU4SSxJQUFWLEVBQWdCL0ksTUFBaEIsRUFBd0J0QyxJQUF4QixFQUE4QjBMLE9BQTlCLEVBQXVDO0FBQ3pELHFCQUFTQyxhQUFULENBQXVCQyxXQUF2QixFQUFvQztBQUNoQyxvQkFBSUMsWUFBYUgsV0FBVyxDQUE1QjtBQUNBLG9CQUFJSSxZQUFhSixVQUFVLE1BQTNCO0FBQ0Esb0JBQUlHLGNBQWMsSUFBZCxJQUFzQkMsWUFBWSxJQUF0QyxFQUE0QztBQUN4Q0EsZ0NBQVlBLFlBQVksSUFBeEI7QUFDQSwyQkFBT0EsU0FBUDtBQUNIO0FBQ0QsdUJBQU9GLFdBQVA7QUFDSDs7QUFFRCxnQkFBSU4sT0FBT0QsS0FBS0UsR0FBaEI7QUFDQSxnQkFBSUMsU0FBU0gsS0FBS0ksTUFBbEI7O0FBRUFILGlCQUFLRSxNQUFMLElBQWUsR0FBZixDQWR5RCxDQWNyQztBQUNwQkYsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQixDQUFuQixDQWZ5RCxDQWVuQzs7QUFFdEJGLGlCQUFLRSxTQUFTLENBQWQsSUFBb0J4TCxRQUFRLENBQTVCO0FBQ0FzTCxpQkFBS0UsU0FBUyxDQUFkLElBQW1CeEwsSUFBbkI7O0FBRUFzTCxpQkFBS0UsU0FBUyxDQUFkLElBQW9CbEosVUFBVSxFQUE5QjtBQUNBZ0osaUJBQUtFLFNBQVMsQ0FBZCxJQUFvQmxKLFVBQVUsRUFBOUI7QUFDQWdKLGlCQUFLRSxTQUFTLENBQWQsSUFBb0JsSixVQUFVLENBQTlCO0FBQ0FnSixpQkFBS0UsU0FBUyxDQUFkLElBQW1CbEosTUFBbkI7O0FBRUEsZ0JBQUl5SixhQUFhSixjQUFjRCxPQUFkLENBQWpCOztBQUVBSixpQkFBS0UsU0FBUyxDQUFkLElBQW9CTyxjQUFjLEVBQWxDO0FBQ0FULGlCQUFLRSxTQUFTLENBQWQsSUFBb0JPLGNBQWMsRUFBbEM7QUFDQVQsaUJBQUtFLFNBQVMsRUFBZCxJQUFxQk8sY0FBYyxDQUFuQztBQUNBVCxpQkFBS0UsU0FBUyxFQUFkLElBQW9CTyxVQUFwQjs7QUFFQVYsaUJBQUtJLE1BQUwsSUFBZSxFQUFmO0FBQ0FKLGlCQUFLL0ssS0FBTDtBQUNILFNBdERVOztBQXdEWG9DLHNCQUFjLFVBQVUySSxJQUFWLEVBQWdCNVIsQ0FBaEIsRUFBbUJDLENBQW5CLEVBQXNCc1MsSUFBdEIsRUFBNEI7QUFDdEMsZ0JBQUlWLE9BQU9ELEtBQUtFLEdBQWhCO0FBQ0EsZ0JBQUlDLFNBQVNILEtBQUtJLE1BQWxCOztBQUVBSCxpQkFBS0UsTUFBTCxJQUFlLENBQWYsQ0FKc0MsQ0FJcEI7O0FBRWxCRixpQkFBS0UsU0FBUyxDQUFkLElBQW1CUSxJQUFuQjs7QUFFQVYsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQi9SLEtBQUssQ0FBeEI7QUFDQTZSLGlCQUFLRSxTQUFTLENBQWQsSUFBbUIvUixDQUFuQjs7QUFFQTZSLGlCQUFLRSxTQUFTLENBQWQsSUFBbUI5UixLQUFLLENBQXhCO0FBQ0E0UixpQkFBS0UsU0FBUyxDQUFkLElBQW1COVIsQ0FBbkI7O0FBRUEyUixpQkFBS0ksTUFBTCxJQUFlLENBQWY7QUFDQUosaUJBQUsvSyxLQUFMO0FBQ0gsU0F4RVU7O0FBMEVYO0FBQ0FILHVCQUFlLFVBQVVrTCxJQUFWLEVBQWdCbkwsSUFBaEIsRUFBc0I7QUFDakMsZ0JBQUlvTCxPQUFPRCxLQUFLRSxHQUFoQjtBQUNBLGdCQUFJQyxTQUFTSCxLQUFLSSxNQUFsQjs7QUFFQUgsaUJBQUtFLE1BQUwsSUFBZSxDQUFmLENBSmlDLENBSWY7O0FBRWxCRixpQkFBS0UsU0FBUyxDQUFkLElBQW1CLENBQW5CLENBTmlDLENBTVg7QUFDdEJGLGlCQUFLRSxTQUFTLENBQWQsSUFBbUIsQ0FBbkIsQ0FQaUMsQ0FPWDtBQUN0QkYsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQixDQUFuQixDQVJpQyxDQVFYOztBQUV0QixnQkFBSVMsSUFBSS9MLEtBQUszRCxNQUFiOztBQUVBK08saUJBQUtFLFNBQVMsQ0FBZCxJQUFtQlMsS0FBSyxFQUF4QjtBQUNBWCxpQkFBS0UsU0FBUyxDQUFkLElBQW1CUyxLQUFLLEVBQXhCO0FBQ0FYLGlCQUFLRSxTQUFTLENBQWQsSUFBbUJTLEtBQUssQ0FBeEI7QUFDQVgsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQlMsQ0FBbkI7O0FBRUEsaUJBQUssSUFBSTNQLElBQUksQ0FBYixFQUFnQkEsSUFBSTJQLENBQXBCLEVBQXVCM1AsR0FBdkIsRUFBNEI7QUFDeEJnUCxxQkFBS0UsU0FBUyxDQUFULEdBQWFsUCxDQUFsQixJQUF3QjRELEtBQUtnTSxVQUFMLENBQWdCNVAsQ0FBaEIsQ0FBeEI7QUFDSDs7QUFFRCtPLGlCQUFLSSxNQUFMLElBQWUsSUFBSVEsQ0FBbkI7QUFDQVosaUJBQUsvSyxLQUFMO0FBQ0gsU0FsR1U7O0FBb0dYRCx3QkFBZ0IsVUFBVWdMLElBQVYsRUFBZ0IxUixLQUFoQixFQUF1QkMsTUFBdkIsRUFBK0J1UyxFQUEvQixFQUFtQzNDLEtBQW5DLEVBQTBDO0FBQ3RELGdCQUFJOEIsT0FBT0QsS0FBS0UsR0FBaEI7QUFDQSxnQkFBSUMsU0FBU0gsS0FBS0ksTUFBbEI7O0FBRUFILGlCQUFLRSxNQUFMLElBQWUsR0FBZixDQUpzRCxDQUlyQjtBQUNqQ0YsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQixDQUFuQixDQUxzRCxDQUtyQjtBQUNqQ0YsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQjdSLFNBQVMsQ0FBNUIsQ0FOc0QsQ0FNckI7QUFDakMyUixpQkFBS0UsU0FBUyxDQUFkLElBQW1CN1IsS0FBbkI7QUFDQTJSLGlCQUFLRSxTQUFTLENBQWQsSUFBbUI1UixVQUFVLENBQTdCLENBUnNELENBUXJCO0FBQ2pDMFIsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQjVSLE1BQW5COztBQUVBMFIsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQixDQUFuQixDQVhzRCxDQVdyQjtBQUNqQ0YsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQixDQUFuQixDQVpzRCxDQVlyQjs7QUFFakM7QUFDQUYsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQlcsTUFBTSxFQUF6QixDQWZzRCxDQWVyQjtBQUNqQ2IsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQlcsTUFBTSxFQUF6QjtBQUNBYixpQkFBS0UsU0FBUyxFQUFkLElBQW9CVyxNQUFNLENBQTFCO0FBQ0FiLGlCQUFLRSxTQUFTLEVBQWQsSUFBb0JXLEVBQXBCO0FBQ0FiLGlCQUFLRSxTQUFTLEVBQWQsSUFBb0IsQ0FBcEIsQ0FuQnNELENBbUJyQjtBQUNqQ0YsaUJBQUtFLFNBQVMsRUFBZCxJQUFvQixDQUFwQjtBQUNBRixpQkFBS0UsU0FBUyxFQUFkLElBQW9CLENBQXBCLENBckJzRCxDQXFCckI7QUFDakNGLGlCQUFLRSxTQUFTLEVBQWQsSUFBb0IsQ0FBcEI7QUFDQUYsaUJBQUtFLFNBQVMsRUFBZCxJQUFvQjdSLFNBQVMsQ0FBN0IsQ0F2QnNELENBdUJyQjtBQUNqQzJSLGlCQUFLRSxTQUFTLEVBQWQsSUFBb0I3UixLQUFwQjtBQUNBMlIsaUJBQUtFLFNBQVMsRUFBZCxJQUFvQjVSLFVBQVUsQ0FBOUIsQ0F6QnNELENBeUJyQjtBQUNqQzBSLGlCQUFLRSxTQUFTLEVBQWQsSUFBb0I1UixNQUFwQjtBQUNBMFIsaUJBQUtFLFNBQVMsRUFBZCxJQUFvQmhDLFNBQVMsRUFBN0IsQ0EzQnNELENBMkJyQjtBQUNqQzhCLGlCQUFLRSxTQUFTLEVBQWQsSUFBb0JoQyxTQUFTLEVBQTdCO0FBQ0E4QixpQkFBS0UsU0FBUyxFQUFkLElBQW9CaEMsU0FBUyxDQUE3QjtBQUNBOEIsaUJBQUtFLFNBQVMsRUFBZCxJQUFvQmhDLEtBQXBCOztBQUVBNkIsaUJBQUtJLE1BQUwsSUFBZSxFQUFmO0FBQ0FKLGlCQUFLL0ssS0FBTDtBQUNILFNBdElVOztBQXdJWG9KLHFCQUFhLFVBQVUyQixJQUFWLEVBQWdCN0IsS0FBaEIsRUFBdUJDLE9BQXZCLEVBQWdDO0FBQ3pDLGdCQUFJNkIsT0FBT0QsS0FBS0UsR0FBaEI7QUFDQSxnQkFBSUMsU0FBU0gsS0FBS0ksTUFBbEI7O0FBRUFILGlCQUFLRSxNQUFMLElBQWUsR0FBZixDQUp5QyxDQUlyQjs7QUFFcEJGLGlCQUFLRSxTQUFTLENBQWQsSUFBbUIsQ0FBbkIsQ0FOeUMsQ0FNbkI7QUFDdEJGLGlCQUFLRSxTQUFTLENBQWQsSUFBbUIsQ0FBbkIsQ0FQeUMsQ0FPbkI7QUFDdEJGLGlCQUFLRSxTQUFTLENBQWQsSUFBbUIsQ0FBbkIsQ0FSeUMsQ0FRbkI7O0FBRXRCRixpQkFBS0UsU0FBUyxDQUFkLElBQW1CaEMsU0FBUyxFQUE1QixDQVZ5QyxDQVVUO0FBQ2hDOEIsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQmhDLFNBQVMsRUFBNUI7QUFDQThCLGlCQUFLRSxTQUFTLENBQWQsSUFBbUJoQyxTQUFTLENBQTVCO0FBQ0E4QixpQkFBS0UsU0FBUyxDQUFkLElBQW1CaEMsS0FBbkI7O0FBRUEsZ0JBQUl5QyxJQUFJeEMsUUFBUWxOLE1BQWhCOztBQUVBK08saUJBQUtFLFNBQVMsQ0FBZCxJQUFtQlMsQ0FBbkIsQ0FqQnlDLENBaUJuQjs7QUFFdEIsaUJBQUssSUFBSTNQLElBQUksQ0FBYixFQUFnQkEsSUFBSTJQLENBQXBCLEVBQXVCM1AsR0FBdkIsRUFBNEI7QUFDeEJnUCxxQkFBS0UsU0FBUyxDQUFULEdBQWFsUCxDQUFsQixJQUF1Qm1OLFFBQVF5QyxVQUFSLENBQW1CNVAsQ0FBbkIsQ0FBdkI7QUFDSDs7QUFFRCtPLGlCQUFLSSxNQUFMLElBQWUsSUFBSVEsQ0FBbkI7QUFDQVosaUJBQUsvSyxLQUFMO0FBQ0gsU0FqS1U7O0FBbUtYc0ssaUNBQXlCLFVBQVVTLElBQVYsRUFBZ0JlLE1BQWhCLEVBQXdCM1MsQ0FBeEIsRUFBMkJDLENBQTNCLEVBQThCQyxLQUE5QixFQUFxQ0MsTUFBckMsRUFBNkM7QUFDbEUsZ0JBQUkwUixPQUFPRCxLQUFLRSxHQUFoQjtBQUNBLGdCQUFJQyxTQUFTSCxLQUFLSSxNQUFsQjs7QUFFQUgsaUJBQUtFLE1BQUwsSUFBZSxHQUFmLENBSmtFLENBSWxDO0FBQ2hDRixpQkFBS0UsU0FBUyxDQUFkLElBQW1CWSxNQUFuQixDQUxrRSxDQUtsQzs7QUFFaENkLGlCQUFLRSxTQUFTLENBQWQsSUFBbUIvUixLQUFLLENBQXhCLENBUGtFLENBT2xDO0FBQ2hDNlIsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQi9SLENBQW5CO0FBQ0E2UixpQkFBS0UsU0FBUyxDQUFkLElBQW1COVIsS0FBSyxDQUF4QixDQVRrRSxDQVNsQztBQUNoQzRSLGlCQUFLRSxTQUFTLENBQWQsSUFBbUI5UixDQUFuQjtBQUNBNFIsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQjdSLFNBQVMsQ0FBNUIsQ0FYa0UsQ0FXbEM7QUFDaEMyUixpQkFBS0UsU0FBUyxDQUFkLElBQW1CN1IsS0FBbkI7QUFDQTJSLGlCQUFLRSxTQUFTLENBQWQsSUFBbUI1UixVQUFVLENBQTdCLENBYmtFLENBYWxDO0FBQ2hDMFIsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQjVSLE1BQW5COztBQUVBeVIsaUJBQUtJLE1BQUwsSUFBZSxFQUFmO0FBQ0FKLGlCQUFLL0ssS0FBTDtBQUNILFNBckxVOztBQXVMWDZILHFCQUFhLFVBQVVrRCxJQUFWLEVBQWdCekUsR0FBaEIsRUFBcUJDLEtBQXJCLEVBQTRCRSxVQUE1QixFQUF3QztBQUNqRCxnQkFBSXVFLE9BQU9ELEtBQUtFLEdBQWhCO0FBQ0EsZ0JBQUlDLFNBQVNILEtBQUtJLE1BQWxCOztBQUVBSCxpQkFBS0UsTUFBTCxJQUFlLENBQWYsQ0FKaUQsQ0FJOUI7O0FBRW5CRixpQkFBS0UsU0FBUyxDQUFkLElBQW1CLENBQW5CLENBTmlELENBTTNCO0FBQ3RCRixpQkFBS0UsU0FBUyxDQUFkLElBQW1CLENBQW5CLENBUGlELENBTzNCO0FBQ3RCRixpQkFBS0UsU0FBUyxDQUFkLElBQW1CLENBQW5CLENBUmlELENBUTNCOztBQUV0QkYsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQjVFLE1BQU0sQ0FBekIsQ0FWaUQsQ0FVVDtBQUN4QzBFLGlCQUFLRSxTQUFTLENBQWQsSUFBbUIzRSxRQUFRLENBQTNCLENBWGlELENBV1Q7QUFDeEN5RSxpQkFBS0UsU0FBUyxDQUFkLElBQW1CLENBQW5CLENBWmlELENBWVQ7QUFDeENGLGlCQUFLRSxTQUFTLENBQWQsSUFBbUJ6RSxhQUFhLENBQWIsR0FBaUIsQ0FBcEMsQ0FiaUQsQ0FhVDs7QUFFeEN1RSxpQkFBS0UsU0FBUyxDQUFkLElBQW1CLENBQW5CLENBZmlELENBZXhCO0FBQ3pCRixpQkFBS0UsU0FBUyxDQUFkLElBQW1CLEdBQW5CLENBaEJpRCxDQWdCeEI7O0FBRXpCRixpQkFBS0UsU0FBUyxFQUFkLElBQW9CLENBQXBCLENBbEJpRCxDQWtCeEI7QUFDekJGLGlCQUFLRSxTQUFTLEVBQWQsSUFBb0IsR0FBcEIsQ0FuQmlELENBbUJ4Qjs7QUFFekJGLGlCQUFLRSxTQUFTLEVBQWQsSUFBb0IsQ0FBcEIsQ0FyQmlELENBcUJ4QjtBQUN6QkYsaUJBQUtFLFNBQVMsRUFBZCxJQUFvQixHQUFwQixDQXRCaUQsQ0FzQnhCOztBQUV6QkYsaUJBQUtFLFNBQVMsRUFBZCxJQUFvQixFQUFwQixDQXhCaUQsQ0F3QnhCO0FBQ3pCRixpQkFBS0UsU0FBUyxFQUFkLElBQW9CLENBQXBCLENBekJpRCxDQXlCeEI7QUFDekJGLGlCQUFLRSxTQUFTLEVBQWQsSUFBb0IsQ0FBcEIsQ0ExQmlELENBMEJ4Qjs7QUFFekJGLGlCQUFLRSxTQUFTLEVBQWQsSUFBb0IsQ0FBcEIsQ0E1QmlELENBNEJ4QjtBQUN6QkYsaUJBQUtFLFNBQVMsRUFBZCxJQUFvQixDQUFwQixDQTdCaUQsQ0E2QnhCO0FBQ3pCRixpQkFBS0UsU0FBUyxFQUFkLElBQW9CLENBQXBCLENBOUJpRCxDQThCeEI7O0FBRXpCSCxpQkFBS0ksTUFBTCxJQUFlLEVBQWY7QUFDQUosaUJBQUsvSyxLQUFMO0FBQ0gsU0F6TlU7O0FBMk5YOEgseUJBQWlCLFVBQVVpRCxJQUFWLEVBQWdCZ0IsU0FBaEIsRUFBMkJDLFlBQTNCLEVBQXlDdkYsVUFBekMsRUFBcUQ7QUFDbEUsZ0JBQUl1RSxPQUFPRCxLQUFLRSxHQUFoQjtBQUNBLGdCQUFJQyxTQUFTSCxLQUFLSSxNQUFsQjs7QUFFQUgsaUJBQUtFLE1BQUwsSUFBZSxDQUFmLENBSmtFLENBSWhEO0FBQ2xCRixpQkFBS0UsU0FBUyxDQUFkLElBQW1CLENBQW5CLENBTGtFLENBSzVDOztBQUV0Qjs7QUFFQSxnQkFBSWxQLENBQUo7QUFBQSxnQkFBT2lRLElBQUlmLFNBQVMsQ0FBcEI7QUFBQSxnQkFBdUJnQixNQUFNLENBQTdCO0FBQ0EsaUJBQUtsUSxJQUFJLENBQVQsRUFBWUEsSUFBSStQLFVBQVU5UCxNQUExQixFQUFrQ0QsR0FBbEMsRUFBdUM7QUFDbkMsb0JBQUkrUCxVQUFVL1AsQ0FBVixFQUFhLENBQWIsTUFBb0IsUUFBcEIsSUFBZ0MsQ0FBQ2dRLFlBQXJDLEVBQW1EO0FBQy9DLG1DQUFLdlEsS0FBTCxDQUFXLGlDQUFYO0FBQ0gsaUJBRkQsTUFFTyxJQUFJc1EsVUFBVS9QLENBQVYsRUFBYSxDQUFiLE1BQW9CLE9BQXBCLElBQStCLENBQUN5SyxVQUFwQyxFQUFnRDtBQUNuRDtBQUNBLG1DQUFLckosSUFBTCxDQUFVLHdEQUFWO0FBQ0gsaUJBSE0sTUFHQTtBQUNILHdCQUFJK08sTUFBTUosVUFBVS9QLENBQVYsRUFBYSxDQUFiLENBQVY7QUFDQWdQLHlCQUFLaUIsQ0FBTCxJQUFVRSxPQUFPLEVBQWpCO0FBQ0FuQix5QkFBS2lCLElBQUksQ0FBVCxJQUFjRSxPQUFPLEVBQXJCO0FBQ0FuQix5QkFBS2lCLElBQUksQ0FBVCxJQUFjRSxPQUFPLENBQXJCO0FBQ0FuQix5QkFBS2lCLElBQUksQ0FBVCxJQUFjRSxHQUFkOztBQUVBRix5QkFBSyxDQUFMO0FBQ0FDO0FBQ0g7QUFDSjs7QUFFRGxCLGlCQUFLRSxTQUFTLENBQWQsSUFBbUJnQixPQUFPLENBQTFCO0FBQ0FsQixpQkFBS0UsU0FBUyxDQUFkLElBQW1CZ0IsR0FBbkI7O0FBRUFuQixpQkFBS0ksTUFBTCxJQUFlYyxJQUFJZixNQUFuQjtBQUNBSCxpQkFBSy9LLEtBQUw7QUFDSCxTQTVQVTs7QUE4UFhnSSwwQkFBa0IsVUFBVStDLElBQVYsRUFBZ0JxQixVQUFoQixFQUE0QkMsVUFBNUIsRUFBd0NDLFFBQXhDLEVBQWtEQyxTQUFsRCxFQUE2RDtBQUMzRSxnQkFBSUMsa0JBQWtCLENBQXRCOztBQUVBLGdCQUFJQyxLQUFLSixXQUFXSyxRQUFwQjtBQUNBLGdCQUFJQyxDQUFKLEVBQU9DLENBQVA7QUFDQSxnQkFBSSxDQUFDUixVQUFELElBQWdCSyxHQUFHRSxDQUFILEdBQU8sQ0FBUCxJQUFZRixHQUFHRyxDQUFILEdBQU8sQ0FBdkMsRUFBMkM7QUFDdkNELG9CQUFJLE9BQU9GLEdBQUdFLENBQVYsS0FBZ0IsV0FBaEIsR0FBOEJMLFFBQTlCLEdBQXlDRyxHQUFHRSxDQUFoRDtBQUNBQyxvQkFBSSxPQUFPSCxHQUFHRyxDQUFWLEtBQWdCLFdBQWhCLEdBQThCTCxTQUE5QixHQUEwQ0UsR0FBR0csQ0FBakQ7QUFDQTtBQUNBeFYsb0JBQUl1SCxRQUFKLENBQWFrTyxlQUFiLENBQTZCOUIsSUFBN0IsRUFBbUMsQ0FBbkMsRUFBc0MwQixHQUFHdFQsQ0FBekMsRUFBNENzVCxHQUFHclQsQ0FBL0MsRUFBa0R1VCxDQUFsRCxFQUFxREMsQ0FBckQ7QUFDSDs7QUFFRCxpQkFBSyxJQUFJNVEsSUFBSSxDQUFiLEVBQWdCQSxJQUFJcVEsV0FBV1MsVUFBWCxDQUFzQjdRLE1BQTFDLEVBQWtERCxHQUFsRCxFQUF1RDtBQUNuRCxvQkFBSStRLEtBQUtWLFdBQVdTLFVBQVgsQ0FBc0I5USxDQUF0QixDQUFUO0FBQ0E7QUFDQTJRLG9CQUFJLE9BQU9JLEdBQUdKLENBQVYsS0FBZ0IsV0FBaEIsR0FBOEJMLFFBQTlCLEdBQXlDUyxHQUFHSixDQUFoRDtBQUNBQyxvQkFBSSxPQUFPRyxHQUFHSCxDQUFWLEtBQWdCLFdBQWhCLEdBQThCTCxTQUE5QixHQUEwQ1EsR0FBR0gsQ0FBakQ7QUFDQXhWLG9CQUFJdUgsUUFBSixDQUFha08sZUFBYixDQUE2QjlCLElBQTdCLEVBQW1DLENBQW5DLEVBQXNDZ0MsR0FBRzVULENBQXpDLEVBQTRDNFQsR0FBRzNULENBQS9DLEVBQWtEdVQsQ0FBbEQsRUFBcURDLENBQXJEO0FBQ0g7QUFDSixTQWpSVTs7QUFtUlhDLHlCQUFpQixVQUFVOUIsSUFBVixFQUFnQmlDLFdBQWhCLEVBQTZCN1QsQ0FBN0IsRUFBZ0NDLENBQWhDLEVBQW1DdVQsQ0FBbkMsRUFBc0NDLENBQXRDLEVBQXlDO0FBQ3RELGdCQUFJNUIsT0FBT0QsS0FBS0UsR0FBaEI7QUFDQSxnQkFBSUMsU0FBU0gsS0FBS0ksTUFBbEI7O0FBRUEsZ0JBQUksT0FBT2hTLENBQVAsS0FBYyxXQUFsQixFQUErQjtBQUFFQSxvQkFBSSxDQUFKO0FBQVE7QUFDekMsZ0JBQUksT0FBT0MsQ0FBUCxLQUFjLFdBQWxCLEVBQStCO0FBQUVBLG9CQUFJLENBQUo7QUFBUTs7QUFFekM0UixpQkFBS0UsTUFBTCxJQUFlLENBQWYsQ0FQc0QsQ0FPbkM7QUFDbkJGLGlCQUFLRSxTQUFTLENBQWQsSUFBbUI4QixXQUFuQjs7QUFFQWhDLGlCQUFLRSxTQUFTLENBQWQsSUFBb0IvUixLQUFLLENBQU4sR0FBVyxJQUE5QjtBQUNBNlIsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQi9SLElBQUksSUFBdkI7O0FBRUE2UixpQkFBS0UsU0FBUyxDQUFkLElBQW9COVIsS0FBSyxDQUFOLEdBQVcsSUFBOUI7QUFDQTRSLGlCQUFLRSxTQUFTLENBQWQsSUFBbUI5UixJQUFJLElBQXZCOztBQUVBNFIsaUJBQUtFLFNBQVMsQ0FBZCxJQUFvQnlCLEtBQUssQ0FBTixHQUFXLElBQTlCO0FBQ0EzQixpQkFBS0UsU0FBUyxDQUFkLElBQW1CeUIsSUFBSSxJQUF2Qjs7QUFFQTNCLGlCQUFLRSxTQUFTLENBQWQsSUFBb0IwQixLQUFLLENBQU4sR0FBVyxJQUE5QjtBQUNBNUIsaUJBQUtFLFNBQVMsQ0FBZCxJQUFtQjBCLElBQUksSUFBdkI7O0FBRUE3QixpQkFBS0ksTUFBTCxJQUFlLEVBQWY7QUFDQUosaUJBQUsvSyxLQUFMO0FBQ0g7QUEzU1UsS0FBZjs7QUE4U0E1SSxRQUFJNE4sTUFBSixHQUFhLFVBQVUvRyxRQUFWLEVBQW9CMkcsU0FBcEIsRUFBK0I7QUFDeEMsWUFBSXRHLFNBQVMsRUFBYjtBQUNBLGFBQUssSUFBSXRDLElBQUksQ0FBYixFQUFnQkEsSUFBSWlDLFNBQVNoQyxNQUE3QixFQUFxQ0QsR0FBckMsRUFBMEM7QUFDdENzQyxtQkFBTzBILElBQVAsQ0FBWS9ILFNBQVMyTixVQUFULENBQW9CNVAsQ0FBcEIsQ0FBWjtBQUNIO0FBQ0QsZUFBUSxrQkFBUXNDLE1BQVIsQ0FBRCxDQUFrQjJPLE9BQWxCLENBQTBCckksU0FBMUIsQ0FBUDtBQUNILEtBTkQ7O0FBUUF4TixRQUFJOFYsZ0JBQUosR0FBdUIsVUFBVUMsR0FBVixFQUFlO0FBQ2xDLGVBQU8sYUFBYSxlQUFPQyxNQUFQLENBQWNELEdBQWQsQ0FBcEI7QUFDSCxLQUZEOztBQUlBL1YsUUFBSXdFLGdCQUFKLEdBQXVCO0FBQ25CeVIsYUFBSyxZQUFZO0FBQ2IsZ0JBQUksS0FBS3hVLElBQUwsQ0FBVUcsS0FBVixLQUFvQixDQUF4QixFQUEyQjtBQUN2QixxQkFBS0gsSUFBTCxDQUFVRyxLQUFWLEdBQWtCLEtBQUtILElBQUwsQ0FBVVMsTUFBNUI7QUFDSDs7QUFFRCxpQkFBS1QsSUFBTCxDQUFVSyxLQUFWLEdBQWtCLEtBQUtMLElBQUwsQ0FBVVEsS0FBVixHQUFrQixLQUFLTSxPQUF6QyxDQUxhLENBS3NDO0FBQ25ELGdCQUFJLEtBQUt2QixLQUFMLENBQVd1TCxNQUFYLENBQWtCLEtBQWxCLEVBQXlCLEtBQUs5SyxJQUFMLENBQVVLLEtBQW5DLENBQUosRUFBK0M7QUFBRSx1QkFBTyxLQUFQO0FBQWU7QUFDaEUsZ0JBQUlvVSxRQUFRLEtBQUt6VSxJQUFMLENBQVVPLENBQVYsSUFBZSxLQUFLUCxJQUFMLENBQVVTLE1BQVYsR0FBbUIsS0FBS1QsSUFBTCxDQUFVRyxLQUE1QyxDQUFaO0FBQ0EsZ0JBQUl1VSxjQUFjM0ssS0FBSzRLLEdBQUwsQ0FBUyxLQUFLM1UsSUFBTCxDQUFVRyxLQUFuQixFQUNTNEosS0FBSzZLLEtBQUwsQ0FBVyxLQUFLclYsS0FBTCxDQUFXdUosS0FBWCxNQUFzQixLQUFLOUksSUFBTCxDQUFVUSxLQUFWLEdBQWtCLEtBQUtNLE9BQTdDLENBQVgsQ0FEVCxDQUFsQjtBQUVBLGlCQUFLdEIsUUFBTCxDQUFjcVYsU0FBZCxDQUF3QixLQUFLN1UsSUFBTCxDQUFVTSxDQUFsQyxFQUFxQ21VLEtBQXJDLEVBQTRDLEtBQUt6VSxJQUFMLENBQVVRLEtBQXRELEVBQ3dCa1UsV0FEeEIsRUFDcUMsS0FBS25WLEtBQUwsQ0FBV3VWLE1BQVgsRUFEckMsRUFFd0IsS0FBS3ZWLEtBQUwsQ0FBV3dWLE9BQVgsRUFGeEI7QUFHQSxpQkFBS3hWLEtBQUwsQ0FBVzRPLFdBQVgsQ0FBdUIsS0FBS25PLElBQUwsQ0FBVVEsS0FBVixHQUFrQmtVLFdBQWxCLEdBQWdDLEtBQUs1VCxPQUE1RDtBQUNBLGlCQUFLZCxJQUFMLENBQVVHLEtBQVYsSUFBbUJ1VSxXQUFuQjs7QUFFQSxnQkFBSSxLQUFLMVUsSUFBTCxDQUFVRyxLQUFWLEdBQWtCLENBQXRCLEVBQXlCO0FBQ3JCLHFCQUFLSCxJQUFMLENBQVVLLEtBQVYsR0FBa0IsS0FBS0wsSUFBTCxDQUFVUSxLQUFWLEdBQWtCLEtBQUtNLE9BQXpDLENBRHFCLENBQzhCO0FBQ3RELGFBRkQsTUFFTztBQUNILHFCQUFLZCxJQUFMLENBQVVDLEtBQVY7QUFDQSxxQkFBS0QsSUFBTCxDQUFVSyxLQUFWLEdBQWtCLENBQWxCO0FBQ0g7O0FBRUQsbUJBQU8sSUFBUDtBQUNILFNBekJrQjs7QUEyQm5CMlUsa0JBQVUsWUFBWTtBQUNsQixpQkFBS2hWLElBQUwsQ0FBVUssS0FBVixHQUFrQixDQUFsQjtBQUNBLGdCQUFJLEtBQUtkLEtBQUwsQ0FBV3VMLE1BQVgsQ0FBa0IsVUFBbEIsRUFBOEIsQ0FBOUIsQ0FBSixFQUFzQztBQUFFLHVCQUFPLEtBQVA7QUFBZTtBQUN2RCxpQkFBS3RMLFFBQUwsQ0FBY3lWLFNBQWQsQ0FBd0IsS0FBSzFWLEtBQUwsQ0FBV2lPLFNBQVgsRUFBeEIsRUFBZ0QsS0FBS2pPLEtBQUwsQ0FBV2lPLFNBQVgsRUFBaEQsRUFDd0IsS0FBS3hOLElBQUwsQ0FBVU0sQ0FEbEMsRUFDcUMsS0FBS04sSUFBTCxDQUFVTyxDQUQvQyxFQUNrRCxLQUFLUCxJQUFMLENBQVVRLEtBRDVELEVBRXdCLEtBQUtSLElBQUwsQ0FBVVMsTUFGbEM7O0FBSUEsaUJBQUtULElBQUwsQ0FBVUMsS0FBVjtBQUNBLGlCQUFLRCxJQUFMLENBQVVLLEtBQVYsR0FBa0IsQ0FBbEI7QUFDQSxtQkFBTyxJQUFQO0FBQ0gsU0FyQ2tCOztBQXVDbkI2VSxhQUFLLFlBQVk7QUFDYixnQkFBSUMsS0FBSjtBQUNBLGdCQUFJLEtBQUtuVixJQUFMLENBQVVFLFFBQVYsS0FBdUIsQ0FBM0IsRUFBOEI7QUFDMUIscUJBQUtGLElBQUwsQ0FBVUssS0FBVixHQUFrQixJQUFJLEtBQUtTLE9BQTNCO0FBQ0Esb0JBQUksS0FBS3ZCLEtBQUwsQ0FBV3VMLE1BQVgsQ0FBa0IsS0FBbEIsRUFBeUIsSUFBSSxLQUFLaEssT0FBbEMsQ0FBSixFQUFnRDtBQUFFLDJCQUFPLEtBQVA7QUFBZTtBQUNqRSxxQkFBS2QsSUFBTCxDQUFVRSxRQUFWLEdBQXFCLEtBQUtYLEtBQUwsQ0FBV3lMLFNBQVgsRUFBckI7QUFDQW1LLHdCQUFRLEtBQUs1VixLQUFMLENBQVcyTCxZQUFYLENBQXdCLEtBQUtwSyxPQUE3QixDQUFSLENBSjBCLENBSXNCO0FBQ2hELHFCQUFLdEIsUUFBTCxDQUFjNFYsUUFBZCxDQUF1QixLQUFLcFYsSUFBTCxDQUFVTSxDQUFqQyxFQUFvQyxLQUFLTixJQUFMLENBQVVPLENBQTlDLEVBQWlELEtBQUtQLElBQUwsQ0FBVVEsS0FBM0QsRUFBa0UsS0FBS1IsSUFBTCxDQUFVUyxNQUE1RSxFQUFvRjBVLEtBQXBGO0FBQ0g7O0FBRUQsbUJBQU8sS0FBS25WLElBQUwsQ0FBVUUsUUFBVixHQUFxQixDQUFyQixJQUEwQixLQUFLWCxLQUFMLENBQVd1SixLQUFYLE1BQXVCLEtBQUtoSSxPQUFMLEdBQWUsQ0FBdkUsRUFBMkU7QUFDdkVxVSx3QkFBUSxLQUFLNVYsS0FBTCxDQUFXMkwsWUFBWCxDQUF3QixLQUFLcEssT0FBN0IsQ0FBUjtBQUNBLG9CQUFJUixJQUFJLEtBQUtmLEtBQUwsQ0FBV2lPLFNBQVgsRUFBUjtBQUNBLG9CQUFJak4sSUFBSSxLQUFLaEIsS0FBTCxDQUFXaU8sU0FBWCxFQUFSO0FBQ0Esb0JBQUloTixRQUFRLEtBQUtqQixLQUFMLENBQVdpTyxTQUFYLEVBQVo7QUFDQSxvQkFBSS9NLFNBQVMsS0FBS2xCLEtBQUwsQ0FBV2lPLFNBQVgsRUFBYjtBQUNBLHFCQUFLaE8sUUFBTCxDQUFjNFYsUUFBZCxDQUF1QixLQUFLcFYsSUFBTCxDQUFVTSxDQUFWLEdBQWNBLENBQXJDLEVBQXdDLEtBQUtOLElBQUwsQ0FBVU8sQ0FBVixHQUFjQSxDQUF0RCxFQUF5REMsS0FBekQsRUFBZ0VDLE1BQWhFLEVBQXdFMFUsS0FBeEU7QUFDQSxxQkFBS25WLElBQUwsQ0FBVUUsUUFBVjtBQUNIOztBQUVELGdCQUFJLEtBQUtGLElBQUwsQ0FBVUUsUUFBVixHQUFxQixDQUF6QixFQUE0QjtBQUN4QixvQkFBSW1WLFFBQVF0TCxLQUFLNEssR0FBTCxDQUFTLEtBQUtyVCxhQUFkLEVBQTZCLEtBQUt0QixJQUFMLENBQVVFLFFBQXZDLENBQVo7QUFDQSxxQkFBS0YsSUFBTCxDQUFVSyxLQUFWLEdBQWtCLENBQUMsS0FBS1MsT0FBTCxHQUFlLENBQWhCLElBQXFCdVUsS0FBdkM7QUFDSCxhQUhELE1BR087QUFDSCxxQkFBS3JWLElBQUwsQ0FBVUMsS0FBVjtBQUNBLHFCQUFLRCxJQUFMLENBQVVLLEtBQVYsR0FBa0IsQ0FBbEI7QUFDSDs7QUFFRCxtQkFBTyxJQUFQO0FBQ0gsU0FwRWtCOztBQXNFbkJpVixpQkFBUyxZQUFZO0FBQ2pCLGdCQUFJQyxLQUFLLEtBQUtoVyxLQUFMLENBQVd1VixNQUFYLEVBQVQ7QUFDQSxnQkFBSVUsTUFBTSxLQUFLalcsS0FBTCxDQUFXd1YsT0FBWCxFQUFWOztBQUVBLGdCQUFJLEtBQUsvVSxJQUFMLENBQVVJLEtBQVYsS0FBb0IsQ0FBeEIsRUFBMkI7QUFDdkIscUJBQUtKLElBQUwsQ0FBVXlWLE9BQVYsR0FBb0IxTCxLQUFLMkwsSUFBTCxDQUFVLEtBQUsxVixJQUFMLENBQVVRLEtBQVYsR0FBa0IsRUFBNUIsQ0FBcEI7QUFDQSxxQkFBS1IsSUFBTCxDQUFVMlYsT0FBVixHQUFvQjVMLEtBQUsyTCxJQUFMLENBQVUsS0FBSzFWLElBQUwsQ0FBVVMsTUFBVixHQUFtQixFQUE3QixDQUFwQjtBQUNBLHFCQUFLVCxJQUFMLENBQVU0VixXQUFWLEdBQXdCLEtBQUs1VixJQUFMLENBQVV5VixPQUFWLEdBQW9CLEtBQUt6VixJQUFMLENBQVUyVixPQUF0RDtBQUNBLHFCQUFLM1YsSUFBTCxDQUFVSSxLQUFWLEdBQWtCLEtBQUtKLElBQUwsQ0FBVTRWLFdBQTVCO0FBQ0g7O0FBRUQsbUJBQU8sS0FBSzVWLElBQUwsQ0FBVUksS0FBVixHQUFrQixDQUF6QixFQUE0QjtBQUN4QixxQkFBS0osSUFBTCxDQUFVSyxLQUFWLEdBQWtCLENBQWxCO0FBQ0Esb0JBQUksS0FBS2QsS0FBTCxDQUFXdUwsTUFBWCxDQUFrQixxQkFBbEIsRUFBeUMsS0FBSzlLLElBQUwsQ0FBVUssS0FBbkQsQ0FBSixFQUErRDtBQUFFLDJCQUFPLEtBQVA7QUFBZTtBQUNoRixvQkFBSU0sY0FBYzRVLEdBQUdDLEdBQUgsQ0FBbEIsQ0FId0IsQ0FHSTtBQUM1QixvQkFBSTdVLGNBQWMsRUFBbEIsRUFBc0I7QUFBRztBQUNyQix5QkFBSzBELEtBQUwsQ0FBVywrQ0FBK0MxRCxXQUExRDtBQUNBLDJCQUFPLEtBQVA7QUFDSDs7QUFFRCxvQkFBSVQsV0FBVyxDQUFmO0FBQ0Esb0JBQUkyVixZQUFZLEtBQUs3VixJQUFMLENBQVU0VixXQUFWLEdBQXdCLEtBQUs1VixJQUFMLENBQVVJLEtBQWxEO0FBQ0Esb0JBQUkwVixTQUFTRCxZQUFZLEtBQUs3VixJQUFMLENBQVV5VixPQUFuQztBQUNBLG9CQUFJTSxTQUFTaE0sS0FBSzZLLEtBQUwsQ0FBV2lCLFlBQVksS0FBSzdWLElBQUwsQ0FBVXlWLE9BQWpDLENBQWI7QUFDQSxvQkFBSW5WLElBQUksS0FBS04sSUFBTCxDQUFVTSxDQUFWLEdBQWN3VixTQUFTLEVBQS9CO0FBQ0Esb0JBQUl2VixJQUFJLEtBQUtQLElBQUwsQ0FBVU8sQ0FBVixHQUFjd1YsU0FBUyxFQUEvQjtBQUNBLG9CQUFJakMsSUFBSS9KLEtBQUs0SyxHQUFMLENBQVMsRUFBVCxFQUFjLEtBQUszVSxJQUFMLENBQVVNLENBQVYsR0FBYyxLQUFLTixJQUFMLENBQVVRLEtBQXpCLEdBQWtDRixDQUEvQyxDQUFSO0FBQ0Esb0JBQUl5VCxJQUFJaEssS0FBSzRLLEdBQUwsQ0FBUyxFQUFULEVBQWMsS0FBSzNVLElBQUwsQ0FBVU8sQ0FBVixHQUFjLEtBQUtQLElBQUwsQ0FBVVMsTUFBekIsR0FBbUNGLENBQWhELENBQVI7O0FBRUE7QUFDQSxvQkFBSUksY0FBYyxJQUFsQixFQUF3QjtBQUFHO0FBQ3ZCLHlCQUFLWCxJQUFMLENBQVVLLEtBQVYsSUFBbUJ5VCxJQUFJQyxDQUFKLEdBQVEsS0FBS2pULE9BQWhDO0FBQ0gsaUJBRkQsTUFFTztBQUNILHdCQUFJSCxjQUFjLElBQWxCLEVBQXdCO0FBQUc7QUFDdkIsNkJBQUtYLElBQUwsQ0FBVUssS0FBVixJQUFtQixLQUFLUyxPQUF4QjtBQUNIO0FBQ0Qsd0JBQUlILGNBQWMsSUFBbEIsRUFBd0I7QUFBRztBQUN2Qiw2QkFBS1gsSUFBTCxDQUFVSyxLQUFWLElBQW1CLEtBQUtTLE9BQXhCO0FBQ0g7QUFDRCx3QkFBSUgsY0FBYyxJQUFsQixFQUF3QjtBQUFHO0FBQ3ZCLDZCQUFLWCxJQUFMLENBQVVLLEtBQVYsR0FEb0IsQ0FDQTtBQUNwQiw0QkFBSSxLQUFLZCxLQUFMLENBQVd1TCxNQUFYLENBQWtCLHlCQUFsQixFQUE2QyxLQUFLOUssSUFBTCxDQUFVSyxLQUF2RCxDQUFKLEVBQW1FO0FBQUUsbUNBQU8sS0FBUDtBQUFlO0FBQ3BGSCxtQ0FBV3FWLEdBQUdDLE1BQU0sS0FBS3hWLElBQUwsQ0FBVUssS0FBaEIsR0FBd0IsQ0FBM0IsQ0FBWCxDQUhvQixDQUd1QjtBQUMzQyw0QkFBSU0sY0FBYyxJQUFsQixFQUF3QjtBQUFHO0FBQ3ZCLGlDQUFLWCxJQUFMLENBQVVLLEtBQVYsSUFBbUJILFlBQVksS0FBS1ksT0FBTCxHQUFlLENBQTNCLENBQW5CO0FBQ0gseUJBRkQsTUFFTztBQUNILGlDQUFLZCxJQUFMLENBQVVLLEtBQVYsSUFBbUJILFdBQVcsQ0FBOUI7QUFDSDtBQUNKO0FBQ0o7O0FBRUQsb0JBQUksS0FBS1gsS0FBTCxDQUFXdUwsTUFBWCxDQUFrQixTQUFsQixFQUE2QixLQUFLOUssSUFBTCxDQUFVSyxLQUF2QyxDQUFKLEVBQW1EO0FBQUUsMkJBQU8sS0FBUDtBQUFlOztBQUVwRTtBQUNBLHFCQUFLTCxJQUFMLENBQVVXLFdBQVYsR0FBd0I0VSxHQUFHQyxHQUFILENBQXhCO0FBQ0FBO0FBQ0Esb0JBQUksS0FBS3hWLElBQUwsQ0FBVVcsV0FBVixLQUEwQixDQUE5QixFQUFpQztBQUM3Qix3QkFBSSxLQUFLWCxJQUFMLENBQVVnVyxlQUFWLEdBQTRCLElBQWhDLEVBQXNDO0FBQ2xDO0FBQ0EsdUNBQUtwVCxLQUFMLENBQVcsK0JBQVg7QUFDSCxxQkFIRCxNQUdPO0FBQ0gsNkJBQUtwRCxRQUFMLENBQWM0VixRQUFkLENBQXVCOVUsQ0FBdkIsRUFBMEJDLENBQTFCLEVBQTZCdVQsQ0FBN0IsRUFBZ0NDLENBQWhDLEVBQW1DLEtBQUsvVCxJQUFMLENBQVVZLFVBQTdDO0FBQ0g7QUFDSixpQkFQRCxNQU9PLElBQUksS0FBS1osSUFBTCxDQUFVVyxXQUFWLEdBQXdCLElBQTVCLEVBQWtDO0FBQUc7QUFDeEMseUJBQUtuQixRQUFMLENBQWNxVixTQUFkLENBQXdCdlUsQ0FBeEIsRUFBMkJDLENBQTNCLEVBQThCdVQsQ0FBOUIsRUFBaUNDLENBQWpDLEVBQW9Dd0IsRUFBcEMsRUFBd0NDLEdBQXhDO0FBQ0FBLDJCQUFPLEtBQUt4VixJQUFMLENBQVVLLEtBQVYsR0FBa0IsQ0FBekI7QUFDSCxpQkFITSxNQUdBO0FBQ0gsd0JBQUksS0FBS0wsSUFBTCxDQUFVVyxXQUFWLEdBQXdCLElBQTVCLEVBQWtDO0FBQUc7QUFDakMsNEJBQUksS0FBS0csT0FBTCxJQUFnQixDQUFwQixFQUF1QjtBQUNuQixpQ0FBS2QsSUFBTCxDQUFVWSxVQUFWLEdBQXVCMlUsR0FBR0MsR0FBSCxDQUF2QjtBQUNILHlCQUZELE1BRU87QUFDSDtBQUNBLGlDQUFLeFYsSUFBTCxDQUFVWSxVQUFWLEdBQXVCLENBQUMyVSxHQUFHQyxHQUFILENBQUQsRUFBVUQsR0FBR0MsTUFBTSxDQUFULENBQVYsRUFBdUJELEdBQUdDLE1BQU0sQ0FBVCxDQUF2QixFQUFvQ0QsR0FBR0MsTUFBTSxDQUFULENBQXBDLENBQXZCO0FBQ0g7QUFDREEsK0JBQU8sS0FBSzFVLE9BQVo7QUFDSDtBQUNELHdCQUFJLEtBQUtkLElBQUwsQ0FBVVcsV0FBVixHQUF3QixJQUE1QixFQUFrQztBQUFHO0FBQ2pDLDRCQUFJLEtBQUtHLE9BQUwsSUFBZ0IsQ0FBcEIsRUFBdUI7QUFDbkIsaUNBQUtkLElBQUwsQ0FBVWlXLFVBQVYsR0FBdUJWLEdBQUdDLEdBQUgsQ0FBdkI7QUFDSCx5QkFGRCxNQUVPO0FBQ0g7QUFDQSxpQ0FBS3hWLElBQUwsQ0FBVWlXLFVBQVYsR0FBdUIsQ0FBQ1YsR0FBR0MsR0FBSCxDQUFELEVBQVVELEdBQUdDLE1BQU0sQ0FBVCxDQUFWLEVBQXVCRCxHQUFHQyxNQUFNLENBQVQsQ0FBdkIsRUFBb0NELEdBQUdDLE1BQU0sQ0FBVCxDQUFwQyxDQUF2QjtBQUNIO0FBQ0RBLCtCQUFPLEtBQUsxVSxPQUFaO0FBQ0g7O0FBRUQseUJBQUt0QixRQUFMLENBQWMwVyxTQUFkLENBQXdCNVYsQ0FBeEIsRUFBMkJDLENBQTNCLEVBQThCdVQsQ0FBOUIsRUFBaUNDLENBQWpDLEVBQW9DLEtBQUsvVCxJQUFMLENBQVVZLFVBQTlDO0FBQ0Esd0JBQUksS0FBS1osSUFBTCxDQUFVVyxXQUFWLEdBQXdCLElBQTVCLEVBQWtDO0FBQUc7QUFDakNULG1DQUFXcVYsR0FBR0MsR0FBSCxDQUFYO0FBQ0FBOztBQUVBLDZCQUFLLElBQUkzTixJQUFJLENBQWIsRUFBZ0JBLElBQUkzSCxRQUFwQixFQUE4QjJILEdBQTlCLEVBQW1DO0FBQy9CLGdDQUFJc04sS0FBSjtBQUNBLGdDQUFJLEtBQUtuVixJQUFMLENBQVVXLFdBQVYsR0FBd0IsSUFBNUIsRUFBa0M7QUFBRztBQUNqQyxvQ0FBSSxLQUFLRyxPQUFMLEtBQWlCLENBQXJCLEVBQXdCO0FBQ3BCcVUsNENBQVFJLEdBQUdDLEdBQUgsQ0FBUjtBQUNILGlDQUZELE1BRU87QUFDSDtBQUNBTCw0Q0FBUSxDQUFDSSxHQUFHQyxHQUFILENBQUQsRUFBVUQsR0FBR0MsTUFBTSxDQUFULENBQVYsRUFBdUJELEdBQUdDLE1BQU0sQ0FBVCxDQUF2QixFQUFvQ0QsR0FBR0MsTUFBTSxDQUFULENBQXBDLENBQVI7QUFDSDtBQUNEQSx1Q0FBTyxLQUFLMVUsT0FBWjtBQUNILDZCQVJELE1BUU87QUFDSHFVLHdDQUFRLEtBQUtuVixJQUFMLENBQVVpVyxVQUFsQjtBQUNIO0FBQ0QsZ0NBQUlFLEtBQUtaLEdBQUdDLEdBQUgsQ0FBVDtBQUNBQTtBQUNBLGdDQUFJWSxLQUFNRCxNQUFNLENBQWhCO0FBQ0EsZ0NBQUlFLEtBQU1GLEtBQUssSUFBZjs7QUFFQSxnQ0FBSUcsS0FBS2YsR0FBR0MsR0FBSCxDQUFUO0FBQ0FBO0FBQ0EsZ0NBQUllLEtBQUssQ0FBQ0QsTUFBTSxDQUFQLElBQVksQ0FBckI7QUFDQSxnQ0FBSUUsS0FBSyxDQUFDRixLQUFLLElBQU4sSUFBYyxDQUF2Qjs7QUFFQSxpQ0FBSzlXLFFBQUwsQ0FBY2lYLE9BQWQsQ0FBc0JMLEVBQXRCLEVBQTBCQyxFQUExQixFQUE4QkUsRUFBOUIsRUFBa0NDLEVBQWxDLEVBQXNDckIsS0FBdEM7QUFDSDtBQUNKO0FBQ0QseUJBQUszVixRQUFMLENBQWNrWCxVQUFkO0FBQ0g7QUFDRCxxQkFBS25YLEtBQUwsQ0FBV29YLE9BQVgsQ0FBbUJuQixHQUFuQjtBQUNBLHFCQUFLeFYsSUFBTCxDQUFVZ1csZUFBVixHQUE0QixLQUFLaFcsSUFBTCxDQUFVVyxXQUF0QztBQUNBLHFCQUFLWCxJQUFMLENBQVVLLEtBQVYsR0FBa0IsQ0FBbEI7QUFDQSxxQkFBS0wsSUFBTCxDQUFVSSxLQUFWO0FBQ0g7O0FBRUQsZ0JBQUksS0FBS0osSUFBTCxDQUFVSSxLQUFWLEtBQW9CLENBQXhCLEVBQTJCO0FBQ3ZCLHFCQUFLSixJQUFMLENBQVVDLEtBQVY7QUFDSDs7QUFFRCxtQkFBTyxJQUFQO0FBQ0gsU0F4TWtCOztBQTBNbkIyVyx5QkFBaUIsVUFBVXRDLEdBQVYsRUFBZTtBQUM1QixnQkFBSXVDLFNBQVMsQ0FBYjtBQUFBLGdCQUFnQkMsT0FBTyxDQUF2QjtBQUNBQSxvQkFBUXhDLElBQUksQ0FBSixJQUFTLElBQWpCO0FBQ0EsZ0JBQUlBLElBQUksQ0FBSixJQUFTLElBQWIsRUFBbUI7QUFDZnVDO0FBQ0FDLHdCQUFRLENBQUN4QyxJQUFJLENBQUosSUFBUyxJQUFWLEtBQW1CLENBQTNCO0FBQ0Esb0JBQUlBLElBQUksQ0FBSixJQUFTLElBQWIsRUFBbUI7QUFDZnVDO0FBQ0FDLDRCQUFReEMsSUFBSSxDQUFKLEtBQVUsRUFBbEI7QUFDSDtBQUNKO0FBQ0QsbUJBQU8sQ0FBQ3VDLE1BQUQsRUFBU0MsSUFBVCxDQUFQO0FBQ0gsU0F0TmtCOztBQXdObkJDLHVCQUFlLFVBQVVDLFVBQVYsRUFBc0I7QUFDakMsZ0JBQUksS0FBS2pXLFNBQUwsS0FBbUIsQ0FBdkIsRUFBMEI7QUFDdEIscUJBQUtzRCxLQUFMLENBQVcsd0RBQVg7QUFDSDs7QUFFRCxpQkFBS3JFLElBQUwsQ0FBVUssS0FBVixHQUFrQixDQUFsQixDQUxpQyxDQUtYO0FBQ3RCLGdCQUFJLEtBQUtkLEtBQUwsQ0FBV3VMLE1BQVgsQ0FBa0IsMkJBQWxCLEVBQStDLEtBQUs5SyxJQUFMLENBQVVLLEtBQXpELENBQUosRUFBcUU7QUFBRSx1QkFBTyxLQUFQO0FBQWU7O0FBRXRGLGdCQUFJNFcsV0FBVyxVQUFVSCxJQUFWLEVBQWdCO0FBQzNCLG9CQUFJSSxNQUFNLENBQVY7QUFDQSxxQkFBSyxJQUFJL1QsSUFBSSxDQUFiLEVBQWdCQSxJQUFJMlQsS0FBSzFULE1BQXpCLEVBQWlDRCxHQUFqQyxFQUFzQztBQUNsQytULDJCQUFPSixLQUFLM1QsQ0FBTCxDQUFQO0FBQ0Esd0JBQUkrVCxNQUFNLEtBQVYsRUFBaUJBLE9BQU8sS0FBUDtBQUNwQjtBQUNELHVCQUFPQSxHQUFQO0FBQ0gsYUFQRDs7QUFTQSxnQkFBSUMsZUFBZSxDQUFuQjtBQUNBLGdCQUFJQyxXQUFXLENBQUMsQ0FBaEI7QUFDQSxnQkFBSUMsYUFBYSxVQUFVUCxJQUFWLEVBQWdCUSxRQUFoQixFQUEwQjtBQUN2QyxxQkFBSyxJQUFJblUsSUFBSSxDQUFiLEVBQWdCQSxJQUFJLENBQXBCLEVBQXVCQSxHQUF2QixFQUE0QjtBQUN4Qix3QkFBS2dVLGdCQUFnQmhVLENBQWpCLEdBQXNCLENBQTFCLEVBQTZCO0FBQ3pCLDZCQUFLbkQsSUFBTCxDQUFVMEgsS0FBVixDQUFnQnZFLENBQWhCLEVBQW1Cb1UsS0FBbkI7QUFDQSx1Q0FBS3hTLElBQUwsQ0FBVSx1QkFBdUI1QixDQUFqQztBQUNIO0FBQ0o7O0FBRUQ7QUFDQSxvQkFBSXFVLGVBQWUsS0FBS3hYLElBQUwsQ0FBVTBILEtBQVYsQ0FBZ0IwUCxRQUFoQixFQUEwQkssT0FBMUIsQ0FBa0NYLElBQWxDLEVBQXdDLElBQXhDLEVBQThDUSxRQUE5QyxDQUFuQjtBQUNBOzs7O0FBSUE7QUFDQSx1QkFBT0UsWUFBUDtBQUNILGFBaEJnQixDQWdCZnRVLElBaEJlLENBZ0JWLElBaEJVLENBQWpCOztBQWtCQSxnQkFBSXdVLHNCQUFzQixVQUFVWixJQUFWLEVBQWdCYSxPQUFoQixFQUF5Qm5YLEtBQXpCLEVBQWdDQyxNQUFoQyxFQUF3QztBQUM5RDtBQUNBO0FBQ0Esb0JBQUltWCxPQUFPLEtBQUt6VyxTQUFoQjtBQUNBLG9CQUFJMlMsSUFBSS9KLEtBQUs2SyxLQUFMLENBQVcsQ0FBQ3BVLFFBQVEsQ0FBVCxJQUFjLENBQXpCLENBQVI7QUFDQSxvQkFBSXFYLEtBQUs5TixLQUFLNkssS0FBTCxDQUFXcFUsUUFBUSxDQUFuQixDQUFUOztBQUVBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUE0QkEscUJBQUssSUFBSUQsSUFBSSxDQUFiLEVBQWdCQSxJQUFJRSxNQUFwQixFQUE0QkYsR0FBNUIsRUFBaUM7QUFDN0Isd0JBQUl1WCxDQUFKLEVBQU94WCxDQUFQLEVBQVV5WCxFQUFWLEVBQWNDLEVBQWQ7QUFDQSx5QkFBSzFYLElBQUksQ0FBVCxFQUFZQSxJQUFJdVgsRUFBaEIsRUFBb0J2WCxHQUFwQixFQUF5QjtBQUNyQiw2QkFBS3dYLElBQUksQ0FBVCxFQUFZQSxLQUFLLENBQWpCLEVBQW9CQSxHQUFwQixFQUF5QjtBQUNyQkMsaUNBQUssQ0FBQ3hYLElBQUlDLEtBQUosR0FBWUYsSUFBSSxDQUFoQixHQUFvQixDQUFwQixHQUF3QndYLENBQXpCLElBQThCLENBQW5DO0FBQ0FFLGlDQUFLLENBQUNsQixLQUFLdlcsSUFBSXVULENBQUosR0FBUXhULENBQWIsS0FBbUJ3WCxDQUFuQixHQUF1QixDQUF4QixJQUE2QixDQUFsQztBQUNBRixpQ0FBS0csRUFBTCxJQUFXSixRQUFRSyxFQUFSLENBQVg7QUFDQUosaUNBQUtHLEtBQUssQ0FBVixJQUFlSixRQUFRSyxLQUFLLENBQWIsQ0FBZjtBQUNBSixpQ0FBS0csS0FBSyxDQUFWLElBQWVKLFFBQVFLLEtBQUssQ0FBYixDQUFmO0FBQ0FKLGlDQUFLRyxLQUFLLENBQVYsSUFBZSxHQUFmO0FBQ0g7QUFDSjs7QUFFRCx5QkFBS0QsSUFBSSxDQUFULEVBQVlBLEtBQUssSUFBSXRYLFFBQVEsQ0FBN0IsRUFBZ0NzWCxHQUFoQyxFQUFxQztBQUNqQ0MsNkJBQUssQ0FBQ3hYLElBQUlDLEtBQUosR0FBWUYsSUFBSSxDQUFoQixHQUFvQixDQUFwQixHQUF3QndYLENBQXpCLElBQThCLENBQW5DO0FBQ0FFLDZCQUFLLENBQUNsQixLQUFLdlcsSUFBSXVULENBQUosR0FBUXhULENBQWIsS0FBbUJ3WCxDQUFuQixHQUF1QixDQUF4QixJQUE2QixDQUFsQztBQUNBRiw2QkFBS0csRUFBTCxJQUFXSixRQUFRSyxFQUFSLENBQVg7QUFDQUosNkJBQUtHLEtBQUssQ0FBVixJQUFlSixRQUFRSyxLQUFLLENBQWIsQ0FBZjtBQUNBSiw2QkFBS0csS0FBSyxDQUFWLElBQWVKLFFBQVFLLEtBQUssQ0FBYixDQUFmO0FBQ0FKLDZCQUFLRyxLQUFLLENBQVYsSUFBZSxHQUFmO0FBQ0g7QUFDSjs7QUFFRCx1QkFBT0gsSUFBUDtBQUNILGFBM0R5QixDQTJEeEIxVSxJQTNEd0IsQ0EyRG5CLElBM0RtQixDQUExQjs7QUE2REEsZ0JBQUkrVSxnQkFBZ0IsVUFBVW5CLElBQVYsRUFBZ0JhLE9BQWhCLEVBQXlCblgsS0FBekIsRUFBZ0NDLE1BQWhDLEVBQXdDO0FBQ3hEO0FBQ0Esb0JBQUltWCxPQUFPLEtBQUt6VyxTQUFoQjtBQUNBLG9CQUFJK1csUUFBUTFYLFFBQVFDLE1BQVIsR0FBaUIsQ0FBN0I7QUFDQSxxQkFBSyxJQUFJMEMsSUFBSSxDQUFSLEVBQVdpUSxJQUFJLENBQXBCLEVBQXVCalEsSUFBSStVLEtBQTNCLEVBQWtDL1UsS0FBSyxDQUFMLEVBQVFpUSxHQUExQyxFQUErQztBQUMzQyx3QkFBSTRFLEtBQUtsQixLQUFLMUQsQ0FBTCxJQUFVLENBQW5CO0FBQ0F3RSx5QkFBS3pVLENBQUwsSUFBVXdVLFFBQVFLLEVBQVIsQ0FBVjtBQUNBSix5QkFBS3pVLElBQUksQ0FBVCxJQUFjd1UsUUFBUUssS0FBSyxDQUFiLENBQWQ7QUFDQUoseUJBQUt6VSxJQUFJLENBQVQsSUFBY3dVLFFBQVFLLEtBQUssQ0FBYixDQUFkO0FBQ0FKLHlCQUFLelUsSUFBSSxDQUFULElBQWMsR0FBZDtBQUNIOztBQUVELHVCQUFPeVUsSUFBUDtBQUNILGFBYm1CLENBYWxCMVUsSUFia0IsQ0FhYixJQWJhLENBQXBCOztBQWVBLGdCQUFJc1MsTUFBTSxLQUFLalcsS0FBTCxDQUFXd1YsT0FBWCxFQUFWO0FBQ0EsZ0JBQUlRLEtBQUssS0FBS2hXLEtBQUwsQ0FBVzRZLE9BQVgsRUFBVDtBQUNBLGdCQUFJQyxLQUFKLEVBQVd0QixJQUFYO0FBQ0EsZ0JBQUl1QixTQUFKLEVBQWVDLE9BQWY7O0FBRUEsZ0JBQUlDLGdCQUFnQixZQUFZO0FBQzVCLG9CQUFJQyxZQUFZakQsR0FBR0MsTUFBTSxDQUFULElBQWMsQ0FBOUI7QUFDQSxvQkFBSWlELGNBQWNELFlBQVksS0FBS3pYLFNBQW5DO0FBQ0EscUJBQUtmLElBQUwsQ0FBVUssS0FBVixJQUFtQm9ZLFdBQW5CO0FBQ0Esb0JBQUksS0FBS2xaLEtBQUwsQ0FBV3VMLE1BQVgsQ0FBa0IsbUJBQW1Cc04sS0FBckMsRUFBNEMsS0FBS3BZLElBQUwsQ0FBVUssS0FBdEQsQ0FBSixFQUFrRTtBQUFFLDJCQUFPLEtBQVA7QUFBZTs7QUFFbkYsb0JBQUlvTixNQUFPK0ssYUFBYSxDQUFkLEdBQW1CLENBQW5CLEdBQXVCLENBQWpDO0FBQ0Esb0JBQUlFLFVBQVUzTyxLQUFLNkssS0FBTCxDQUFXLENBQUMsS0FBSzVVLElBQUwsQ0FBVVEsS0FBVixHQUFrQmlOLEdBQWxCLEdBQXdCLENBQXpCLElBQThCLENBQXpDLENBQWQ7QUFDQSxvQkFBSWtMLE1BQU0sS0FBVjtBQUNBLG9CQUFJRCxVQUFVLEtBQUsxWSxJQUFMLENBQVVTLE1BQXBCLEdBQTZCLEVBQWpDLEVBQXFDO0FBQ2pDa1ksMEJBQU0sSUFBTjtBQUNBTixnQ0FBWSxDQUFaO0FBQ0FDLDhCQUFVSSxVQUFVLEtBQUsxWSxJQUFMLENBQVVTLE1BQTlCO0FBQ0E7QUFDSCxpQkFMRCxNQUtPO0FBQ0g7QUFDQSx3QkFBSW1ZLFlBQVlwRCxNQUFNLENBQU4sR0FBVWlELFdBQTFCO0FBQ0FKLGdDQUFZLENBQVo7QUFDQUMsOEJBQVUsQ0FBVjtBQUNBQSwrQkFBVy9DLEdBQUdxRCxTQUFILElBQWdCLElBQTNCO0FBQ0Esd0JBQUlyRCxHQUFHcUQsU0FBSCxJQUFnQixJQUFwQixFQUEwQjtBQUN0QlA7QUFDQUMsbUNBQVcsQ0FBQy9DLEdBQUdxRCxZQUFZLENBQWYsSUFBb0IsSUFBckIsS0FBOEIsQ0FBekM7QUFDQSw0QkFBSXJELEdBQUdxRCxZQUFZLENBQWYsSUFBb0IsSUFBeEIsRUFBOEI7QUFDMUJQO0FBQ0FDLHVDQUFXL0MsR0FBR3FELFlBQVksQ0FBZixLQUFxQixFQUFoQztBQUNIO0FBQ0o7QUFDRDtBQUNIOztBQUVELHFCQUFLNVksSUFBTCxDQUFVSyxLQUFWLElBQW1CZ1ksWUFBWUMsT0FBL0I7QUFDQSxvQkFBSSxLQUFLL1ksS0FBTCxDQUFXdUwsTUFBWCxDQUFrQixXQUFXc04sS0FBN0IsRUFBb0MsS0FBS3BZLElBQUwsQ0FBVUssS0FBOUMsQ0FBSixFQUEwRDtBQUFFLDJCQUFPLEtBQVA7QUFBZTs7QUFFM0U7QUFDQSxxQkFBS2QsS0FBTCxDQUFXNE8sV0FBWCxDQUF1QixDQUF2QjtBQUNBO0FBQ0EscUJBQUs1TyxLQUFMLENBQVdzWixTQUFYLENBQXFCLEtBQUt6WCxZQUExQixFQUF3Q3FYLFdBQXhDO0FBQ0EscUJBQUtsWixLQUFMLENBQVc0TyxXQUFYLENBQXVCa0ssU0FBdkI7O0FBRUEsb0JBQUlNLEdBQUosRUFBUztBQUNMN0IsMkJBQU8sS0FBS3ZYLEtBQUwsQ0FBVzJMLFlBQVgsQ0FBd0JvTixPQUF4QixDQUFQO0FBQ0gsaUJBRkQsTUFFTztBQUNIeEIsMkJBQU9PLFdBQVcsS0FBSzlYLEtBQUwsQ0FBVzJMLFlBQVgsQ0FBd0JvTixPQUF4QixDQUFYLEVBQTZDSSxVQUFVLEtBQUsxWSxJQUFMLENBQVVTLE1BQWpFLENBQVA7QUFDSDs7QUFFRDtBQUNBLG9CQUFJcVksSUFBSjtBQUNBLG9CQUFJTixhQUFhLENBQWpCLEVBQW9CO0FBQ2hCTSwyQkFBT3BCLG9CQUFvQlosSUFBcEIsRUFBMEIsS0FBSzFWLFlBQS9CLEVBQTZDLEtBQUtwQixJQUFMLENBQVVRLEtBQXZELEVBQThELEtBQUtSLElBQUwsQ0FBVVMsTUFBeEUsQ0FBUDtBQUNBLHlCQUFLakIsUUFBTCxDQUFjdVosYUFBZCxDQUE0QixLQUFLL1ksSUFBTCxDQUFVTSxDQUF0QyxFQUF5QyxLQUFLTixJQUFMLENBQVVPLENBQW5ELEVBQXNELEtBQUtQLElBQUwsQ0FBVVEsS0FBaEUsRUFBdUUsS0FBS1IsSUFBTCxDQUFVUyxNQUFqRixFQUF5RnFZLElBQXpGLEVBQStGLENBQS9GLEVBQWtHLEtBQWxHO0FBQ0gsaUJBSEQsTUFHTztBQUNIQSwyQkFBT2IsY0FBY25CLElBQWQsRUFBb0IsS0FBSzFWLFlBQXpCLEVBQXVDLEtBQUtwQixJQUFMLENBQVVRLEtBQWpELEVBQXdELEtBQUtSLElBQUwsQ0FBVVMsTUFBbEUsQ0FBUDtBQUNBLHlCQUFLakIsUUFBTCxDQUFjdVosYUFBZCxDQUE0QixLQUFLL1ksSUFBTCxDQUFVTSxDQUF0QyxFQUF5QyxLQUFLTixJQUFMLENBQVVPLENBQW5ELEVBQXNELEtBQUtQLElBQUwsQ0FBVVEsS0FBaEUsRUFBdUUsS0FBS1IsSUFBTCxDQUFVUyxNQUFqRixFQUF5RnFZLElBQXpGLEVBQStGLENBQS9GLEVBQWtHLEtBQWxHO0FBQ0g7O0FBR0QsdUJBQU8sSUFBUDtBQUNILGFBMURtQixDQTBEbEI1VixJQTFEa0IsQ0EwRGIsSUExRGEsQ0FBcEI7O0FBNERBLGdCQUFJOFYsYUFBYSxZQUFZO0FBQ3pCLG9CQUFJTCxNQUFNLEtBQVY7QUFDQSxvQkFBSU0sbUJBQW1CLEtBQUtqWixJQUFMLENBQVVRLEtBQVYsR0FBa0IsS0FBS1IsSUFBTCxDQUFVUyxNQUE1QixHQUFxQyxLQUFLTSxTQUFqRTtBQUNBLG9CQUFJa1ksbUJBQW1CLEVBQXZCLEVBQTJCO0FBQ3ZCTiwwQkFBTSxJQUFOO0FBQ0FOLGdDQUFZLENBQVo7QUFDQUMsOEJBQVVXLGdCQUFWO0FBQ0gsaUJBSkQsTUFJTztBQUNIO0FBQ0Esd0JBQUlMLFlBQVlwRCxNQUFNLENBQXRCO0FBQ0E2QyxnQ0FBWSxDQUFaO0FBQ0FDLDhCQUFVLENBQVY7QUFDQUEsK0JBQVcvQyxHQUFHcUQsU0FBSCxJQUFnQixJQUEzQjtBQUNBLHdCQUFJckQsR0FBR3FELFNBQUgsSUFBZ0IsSUFBcEIsRUFBMEI7QUFDdEJQO0FBQ0FDLG1DQUFXLENBQUMvQyxHQUFHcUQsWUFBWSxDQUFmLElBQW9CLElBQXJCLEtBQThCLENBQXpDO0FBQ0EsNEJBQUlyRCxHQUFHcUQsWUFBWSxDQUFmLElBQW9CLElBQXhCLEVBQThCO0FBQzFCUDtBQUNBQyx1Q0FBVy9DLEdBQUdxRCxZQUFZLENBQWYsS0FBcUIsRUFBaEM7QUFDSDtBQUNKO0FBQ0Q7QUFDSDtBQUNELHFCQUFLNVksSUFBTCxDQUFVSyxLQUFWLEdBQWtCLElBQUlnWSxTQUFKLEdBQWdCQyxPQUFsQztBQUNBLG9CQUFJLEtBQUsvWSxLQUFMLENBQVd1TCxNQUFYLENBQWtCLFdBQVdzTixLQUE3QixFQUFvQyxLQUFLcFksSUFBTCxDQUFVSyxLQUE5QyxDQUFKLEVBQTBEO0FBQUUsMkJBQU8sS0FBUDtBQUFlOztBQUUzRTtBQUNBLHFCQUFLZCxLQUFMLENBQVcyTCxZQUFYLENBQXdCLElBQUltTixTQUE1Qjs7QUFFQSxvQkFBSU0sR0FBSixFQUFTO0FBQ0w3QiwyQkFBTyxLQUFLdlgsS0FBTCxDQUFXMkwsWUFBWCxDQUF3Qm9OLE9BQXhCLENBQVA7QUFDSCxpQkFGRCxNQUVPO0FBQ0h4QiwyQkFBT08sV0FBVyxLQUFLOVgsS0FBTCxDQUFXMkwsWUFBWCxDQUF3Qm9OLE9BQXhCLENBQVgsRUFBNkNXLGdCQUE3QyxDQUFQO0FBQ0g7O0FBRUQscUJBQUt6WixRQUFMLENBQWMwWixZQUFkLENBQTJCLEtBQUtsWixJQUFMLENBQVVNLENBQXJDLEVBQXdDLEtBQUtOLElBQUwsQ0FBVU8sQ0FBbEQsRUFBcUQsS0FBS1AsSUFBTCxDQUFVUSxLQUEvRCxFQUFzRSxLQUFLUixJQUFMLENBQVVTLE1BQWhGLEVBQXdGcVcsSUFBeEYsRUFBOEYsQ0FBOUYsRUFBaUcsS0FBakc7O0FBRUEsdUJBQU8sSUFBUDtBQUNILGFBdENnQixDQXNDZjVULElBdENlLENBc0NWLElBdENVLENBQWpCOztBQXdDQSxnQkFBSWlXLE1BQU0sS0FBSzVaLEtBQUwsQ0FBVzZaLE9BQVgsRUFBVjs7QUFFQTtBQUNBakMsMkJBQWVnQyxNQUFNLEdBQXJCOztBQUVBO0FBQ0FBLGtCQUFNQSxPQUFPLENBQWI7QUFDQS9CLHVCQUFXK0IsTUFBTSxHQUFqQjs7QUFFQSxnQkFBSUEsUUFBUSxJQUFaLEVBQXdCZixRQUFRLE1BQVIsQ0FBeEIsS0FDSyxJQUFJZSxRQUFRLElBQVosRUFBbUJmLFFBQVEsTUFBUixDQUFuQixLQUNBLElBQUllLFFBQVEsSUFBWixFQUFtQmYsUUFBUSxLQUFSLENBQW5CLEtBQ0EsSUFBSWUsTUFBTSxJQUFWLEVBQW1CZixRQUFRLFFBQVIsQ0FBbkIsS0FDQSxJQUFJZSxNQUFNLElBQVYsRUFBbUJmLFFBQVEsTUFBUixDQUFuQixLQUNBLE9BQU8sS0FBSy9ULEtBQUwsQ0FBVyw4Q0FBOEM4VSxHQUF6RCxDQUFQOztBQUVMLGdCQUFJbkMsZUFBZW9CLFVBQVUsUUFBVixJQUFzQkEsVUFBVSxNQUEvQyxDQUFKLEVBQTREO0FBQ3hELHVCQUFPLEtBQUsvVCxLQUFMLENBQVcsdUNBQVgsQ0FBUDtBQUNIOztBQUVELG9CQUFRK1QsS0FBUjtBQUNJO0FBQ0EscUJBQUssTUFBTDtBQUFjO0FBQ1YseUJBQUtwWSxJQUFMLENBQVVLLEtBQVYsSUFBbUIsS0FBS1UsU0FBeEI7QUFDQTtBQUNKLHFCQUFLLE1BQUw7QUFBYztBQUNWLHlCQUFLZixJQUFMLENBQVVLLEtBQVYsSUFBbUIsQ0FBbkI7QUFDQTtBQUNKLHFCQUFLLEtBQUw7QUFBYTtBQUNULHlCQUFLTCxJQUFMLENBQVVLLEtBQVYsSUFBbUIsQ0FBbkI7QUFDQTtBQUNKLHFCQUFLLFFBQUw7QUFBZ0I7QUFDWix5QkFBS0wsSUFBTCxDQUFVSyxLQUFWLElBQW1CLENBQW5CO0FBQ0E7QUFDSixxQkFBSyxNQUFMO0FBQ0k7QUFmUjs7QUFrQkEsZ0JBQUksS0FBS2QsS0FBTCxDQUFXdUwsTUFBWCxDQUFrQixXQUFXc04sS0FBN0IsRUFBb0MsS0FBS3BZLElBQUwsQ0FBVUssS0FBOUMsQ0FBSixFQUEwRDtBQUFFLHVCQUFPLEtBQVA7QUFBZTs7QUFFM0U7QUFDQSxvQkFBUStYLEtBQVI7QUFDSSxxQkFBSyxNQUFMO0FBQ0k7QUFDQSx5QkFBSzVZLFFBQUwsQ0FBYzRWLFFBQWQsQ0FBdUIsS0FBS3BWLElBQUwsQ0FBVU0sQ0FBakMsRUFBb0MsS0FBS04sSUFBTCxDQUFVTyxDQUE5QyxFQUFpRCxLQUFLUCxJQUFMLENBQVVRLEtBQTNELEVBQWtFLEtBQUtSLElBQUwsQ0FBVVMsTUFBNUUsRUFBb0YsQ0FBQzhVLEdBQUdDLE1BQU0sQ0FBVCxDQUFELEVBQWNELEdBQUdDLE1BQU0sQ0FBVCxDQUFkLEVBQTJCRCxHQUFHQyxNQUFNLENBQVQsQ0FBM0IsQ0FBcEYsRUFBNkgsS0FBN0g7QUFDQSx5QkFBS2pXLEtBQUwsQ0FBVzRPLFdBQVgsQ0FBdUIsQ0FBdkI7QUFDQTtBQUNKLHFCQUFLLEtBQUw7QUFDQSxxQkFBSyxNQUFMO0FBQ0k7QUFDQSx3QkFBSXlLLFlBQVlwRCxNQUFNLENBQXRCO0FBQ0E2QyxnQ0FBWSxDQUFaO0FBQ0FDLDhCQUFVLENBQVY7QUFDQUEsK0JBQVcvQyxHQUFHcUQsU0FBSCxJQUFnQixJQUEzQjtBQUNBLHdCQUFJckQsR0FBR3FELFNBQUgsSUFBZ0IsSUFBcEIsRUFBMEI7QUFDdEJQO0FBQ0FDLG1DQUFXLENBQUMvQyxHQUFHcUQsWUFBWSxDQUFmLElBQW9CLElBQXJCLEtBQThCLENBQXpDO0FBQ0EsNEJBQUlyRCxHQUFHcUQsWUFBWSxDQUFmLElBQW9CLElBQXhCLEVBQThCO0FBQzFCUDtBQUNBQyx1Q0FBVy9DLEdBQUdxRCxZQUFZLENBQWYsS0FBcUIsRUFBaEM7QUFDSDtBQUNKO0FBQ0Q7QUFDQSx5QkFBSzVZLElBQUwsQ0FBVUssS0FBVixHQUFrQixJQUFJZ1ksU0FBSixHQUFnQkMsT0FBbEMsQ0FmSixDQWVnRDtBQUM1Qyx3QkFBSSxLQUFLL1ksS0FBTCxDQUFXdUwsTUFBWCxDQUFrQixXQUFXc04sS0FBN0IsRUFBb0MsS0FBS3BZLElBQUwsQ0FBVUssS0FBOUMsQ0FBSixFQUEwRDtBQUFFLCtCQUFPLEtBQVA7QUFBZTs7QUFFM0U7QUFDQSx5QkFBS2QsS0FBTCxDQUFXNE8sV0FBWCxDQUF1QixJQUFJa0ssU0FBM0IsRUFuQkosQ0FtQjRDO0FBQ3hDLHdCQUFJZ0IsTUFBTSxJQUFJQyxLQUFKLEVBQVY7QUFDQUQsd0JBQUlFLEdBQUosR0FBVSxpQkFBaUJuQixLQUFqQixHQUNON1osSUFBSThWLGdCQUFKLENBQXFCLEtBQUs5VSxLQUFMLENBQVcyTCxZQUFYLENBQXdCb04sT0FBeEIsQ0FBckIsQ0FESjtBQUVBLHlCQUFLOVksUUFBTCxDQUFjZ2EsWUFBZCxDQUEyQjtBQUN2QixnQ0FBUSxLQURlO0FBRXZCLCtCQUFPSCxHQUZnQjtBQUd2Qiw2QkFBSyxLQUFLclosSUFBTCxDQUFVTSxDQUhRO0FBSXZCLDZCQUFLLEtBQUtOLElBQUwsQ0FBVU87QUFKUSxxQkFBM0I7QUFNQThZLDBCQUFNLElBQU47QUFDQTtBQUNKLHFCQUFLLFFBQUw7QUFDSSx3QkFBSUksV0FBV2xFLEdBQUdDLE1BQU0sQ0FBVCxDQUFmO0FBQ0Esd0JBQUlpRSxhQUFhLENBQWpCLEVBQW9CO0FBQ2hCLDRCQUFJLENBQUNsQixlQUFMLEVBQXNCO0FBQUUsbUNBQU8sS0FBUDtBQUFlO0FBQzFDLHFCQUZELE1BRU87QUFDSDtBQUNBO0FBQ0EsNkJBQUtsVSxLQUFMLENBQVcscURBQXFEb1YsUUFBaEU7QUFDSDtBQUNEO0FBQ0oscUJBQUssTUFBTDtBQUNJLHdCQUFJLENBQUNULFlBQUwsRUFBbUI7QUFBRSwrQkFBTyxLQUFQO0FBQWU7QUFDcEM7QUFsRFI7O0FBc0RBLGlCQUFLaFosSUFBTCxDQUFVSyxLQUFWLEdBQWtCLENBQWxCO0FBQ0EsaUJBQUtMLElBQUwsQ0FBVUMsS0FBVjs7QUFFQSxtQkFBTyxJQUFQO0FBQ0gsU0FyaEJrQjs7QUF1aEJuQnlaLGVBQU8sWUFBWTtBQUFFLG1CQUFPLEtBQUt0YSxZQUFMLENBQWtCMlgsYUFBbEIsQ0FBZ0MsS0FBaEMsQ0FBUDtBQUFnRCxTQXZoQmxEO0FBd2hCbkI0QyxtQkFBVyxZQUFZO0FBQUUsbUJBQU8sS0FBS3ZhLFlBQUwsQ0FBa0IyWCxhQUFsQixDQUFnQyxJQUFoQyxDQUFQO0FBQStDLFNBeGhCckQ7O0FBMGhCbkI2QyxtQkFBVyxZQUFZO0FBQ25CLGlCQUFLNVosSUFBTCxDQUFVQyxLQUFWLEdBQWtCLENBQWxCO0FBQ0EsbUJBQU8sSUFBUDtBQUNILFNBN2hCa0I7O0FBK2hCbkI0WiwwQkFBa0IsWUFBWTtBQUMxQixpQkFBSzdZLFNBQUwsR0FBaUIsS0FBS2hCLElBQUwsQ0FBVVEsS0FBM0I7QUFDQSxpQkFBS1MsVUFBTCxHQUFrQixLQUFLakIsSUFBTCxDQUFVUyxNQUE1QjtBQUNBLGlCQUFLVSxTQUFMLEdBQWlCLElBQUlFLFVBQUosQ0FBZSxLQUFLTCxTQUFMLEdBQWlCLEtBQUtDLFVBQXRCLEdBQW1DLENBQWxELENBQWpCO0FBQ0EsaUJBQUt6QixRQUFMLENBQWNxUCxNQUFkLENBQXFCLEtBQUs3TixTQUExQixFQUFxQyxLQUFLQyxVQUExQztBQUNBLGlCQUFLNk4sV0FBTCxDQUFpQixJQUFqQixFQUF1QixLQUFLOU4sU0FBNUIsRUFBdUMsS0FBS0MsVUFBNUM7QUFDQSxpQkFBS00sT0FBTCxDQUFhTSxZQUFiLEdBQTZCLElBQUl3TixJQUFKLEVBQUQsQ0FBYUMsT0FBYixFQUE1QjtBQUNBLGlCQUFLMkIsd0JBQUw7O0FBRUEsaUJBQUtqUixJQUFMLENBQVVLLEtBQVYsR0FBa0IsQ0FBbEI7QUFDQSxpQkFBS0wsSUFBTCxDQUFVQyxLQUFWLElBQW1CLENBQW5CO0FBQ0EsbUJBQU8sSUFBUDtBQUNILFNBM2lCa0I7O0FBNmlCbkI2Wiw2QkFBcUIsWUFBWTtBQUM3QixpQkFBSzlaLElBQUwsQ0FBVUssS0FBVixHQUFrQixDQUFsQjtBQUNBLGdCQUFJLEtBQUtkLEtBQUwsQ0FBV3VMLE1BQVgsQ0FBa0IscUJBQWxCLEVBQXlDLEtBQUs5SyxJQUFMLENBQVVLLEtBQW5ELENBQUosRUFBK0Q7QUFBRSx1QkFBTyxLQUFQO0FBQWU7O0FBRWhGLGlCQUFLNEIsdUJBQUwsR0FBK0IsSUFBL0I7QUFDQSxnQkFBSThYLG9CQUFvQixLQUFLeGEsS0FBTCxDQUFXNlosT0FBWCxFQUF4Qjs7QUFFQSxpQkFBS3BaLElBQUwsQ0FBVUssS0FBVixHQUFrQixJQUFLMFosb0JBQW9CLEVBQTNDO0FBQ0EsZ0JBQUksS0FBS3hhLEtBQUwsQ0FBV3VMLE1BQVgsQ0FBa0IscUJBQWxCLEVBQXlDLEtBQUs5SyxJQUFMLENBQVVLLEtBQW5ELENBQUosRUFBK0Q7QUFBRSx1QkFBTyxLQUFQO0FBQWU7O0FBRWhGLGlCQUFLZCxLQUFMLENBQVc0TyxXQUFYLENBQXVCLENBQXZCLEVBVjZCLENBVUQ7QUFDNUIsaUJBQUs1TyxLQUFMLENBQVc0TyxXQUFYLENBQXVCLENBQXZCLEVBWDZCLENBV0Q7O0FBRTVCLGlCQUFLLElBQUloTCxJQUFJLENBQWIsRUFBZ0JBLElBQUk0VyxpQkFBcEIsRUFBdUM1VyxLQUFLLENBQTVDLEVBQStDO0FBQzNDO0FBQ0Esb0JBQUlBLE1BQU0sQ0FBVixFQUFhO0FBQ1QseUJBQUtqQixVQUFMLEdBQWtCLEtBQUszQyxLQUFMLENBQVcyTCxZQUFYLENBQXdCLENBQXhCLENBQWxCLENBRFMsQ0FDd0M7QUFDakQseUJBQUszTCxLQUFMLENBQVc0TyxXQUFYLENBQXVCLENBQXZCLEVBRlMsQ0FFd0M7QUFDakQseUJBQUs1TyxLQUFMLENBQVc0TyxXQUFYLENBQXVCLENBQXZCLEVBSFMsQ0FHd0M7QUFDakQseUJBQUs1TyxLQUFMLENBQVc0TyxXQUFYLENBQXVCLENBQXZCLEVBSlMsQ0FJd0M7QUFDakQseUJBQUs1TyxLQUFMLENBQVc0TyxXQUFYLENBQXVCLENBQXZCLEVBTFMsQ0FLd0M7QUFDakQseUJBQUtoTSxhQUFMLEdBQXFCLEtBQUs1QyxLQUFMLENBQVcyTCxZQUFYLENBQXdCLENBQXhCLENBQXJCLENBTlMsQ0FNd0M7QUFDcEQsaUJBUEQsTUFPTztBQUNILHlCQUFLM0wsS0FBTCxDQUFXNE8sV0FBWCxDQUF1QixFQUF2QjtBQUNIO0FBQ0o7O0FBRUQ7Ozs7Ozs7O0FBUUE7QUFDQSxnQkFBSSxLQUFLbk8sSUFBTCxDQUFVTSxDQUFWLEtBQWdCLENBQWhCLElBQXFCLEtBQUtOLElBQUwsQ0FBVU8sQ0FBVixLQUFnQixDQUF6QyxFQUE0QztBQUN4QyxvQkFBSWlFLE1BQU0sRUFBVjtBQUNBO0FBQ0Esd0JBQVEsS0FBS3hFLElBQUwsQ0FBVU8sQ0FBbEI7QUFDQSx5QkFBSyxDQUFMO0FBQ0lpRSw4QkFBTSx1Q0FBTjtBQUNBO0FBQ0oseUJBQUssQ0FBTDtBQUNJQSw4QkFBTSxrQkFBTjtBQUNBO0FBQ0oseUJBQUssQ0FBTDtBQUNJQSw4QkFBTSx1QkFBTjtBQUNBO0FBQ0o7QUFDSUEsOEJBQU0sZ0JBQU47QUFDQTtBQVpKO0FBY0EsK0JBQUtPLElBQUwsQ0FBVSwrQ0FBK0NQLEdBQXpEO0FBQ0EsdUJBQU8sSUFBUDtBQUNIOztBQUVELGlCQUFLcEYsWUFBTCxDQUFrQnlhLGdCQUFsQjtBQUNBLG1CQUFPLElBQVA7QUFDSCxTQXhtQmtCOztBQTBtQm5CRyxxQkFBYSxZQUFZO0FBQ3JCLGlCQUFLNWEsWUFBTCxDQUFrQnlhLGdCQUFsQjtBQUNBLG1CQUFPLElBQVA7QUFDSCxTQTdtQmtCOztBQSttQm5CSSxnQkFBUSxZQUFZO0FBQ2hCLDJCQUFLclgsS0FBTCxDQUFXLGVBQVg7QUFDQSxnQkFBSXRDLElBQUksS0FBS04sSUFBTCxDQUFVTSxDQUFsQixDQUZnQixDQUVNO0FBQ3RCLGdCQUFJQyxJQUFJLEtBQUtQLElBQUwsQ0FBVU8sQ0FBbEIsQ0FIZ0IsQ0FHTTtBQUN0QixnQkFBSXVULElBQUksS0FBSzlULElBQUwsQ0FBVVEsS0FBbEI7QUFDQSxnQkFBSXVULElBQUksS0FBSy9ULElBQUwsQ0FBVVMsTUFBbEI7O0FBRUEsZ0JBQUl5WixlQUFlcEcsSUFBSUMsQ0FBSixHQUFRLEtBQUtqVCxPQUFoQztBQUNBLGdCQUFJcVosYUFBYXBRLEtBQUs2SyxLQUFMLENBQVcsQ0FBQ2QsSUFBSSxDQUFMLElBQVUsQ0FBckIsSUFBMEJDLENBQTNDOztBQUVBLGlCQUFLL1QsSUFBTCxDQUFVSyxLQUFWLEdBQWtCNlosZUFBZUMsVUFBakM7QUFDQSxnQkFBSSxLQUFLNWEsS0FBTCxDQUFXdUwsTUFBWCxDQUFrQixpQkFBbEIsRUFBcUMsS0FBSzlLLElBQUwsQ0FBVUssS0FBL0MsQ0FBSixFQUEyRDtBQUFFLHVCQUFPLEtBQVA7QUFBZTs7QUFFNUUsaUJBQUtiLFFBQUwsQ0FBYzRhLFlBQWQsQ0FBMkIsS0FBSzdhLEtBQUwsQ0FBVzJMLFlBQVgsQ0FBd0JnUCxZQUF4QixDQUEzQixFQUMyQixLQUFLM2EsS0FBTCxDQUFXMkwsWUFBWCxDQUF3QmlQLFVBQXhCLENBRDNCLEVBRTJCN1osQ0FGM0IsRUFFOEJDLENBRjlCLEVBRWlDdVQsQ0FGakMsRUFFb0NDLENBRnBDOztBQUlBLGlCQUFLL1QsSUFBTCxDQUFVSyxLQUFWLEdBQWtCLENBQWxCO0FBQ0EsaUJBQUtMLElBQUwsQ0FBVUMsS0FBVjs7QUFFQSwyQkFBSzJDLEtBQUwsQ0FBVyxlQUFYO0FBQ0EsbUJBQU8sSUFBUDtBQUNILFNBcm9Ca0I7O0FBdW9CbkJ3Ryw4QkFBc0IsWUFBWTtBQUM5QixpQkFBS3BKLElBQUwsQ0FBVUMsS0FBVjs7QUFFQSxnQkFBSW9hLGdCQUFnQjFYLFNBQVMyWCxXQUFULENBQXFCLGVBQXJCLENBQXBCO0FBQ0EsZ0JBQUlELGNBQWM1VixJQUFkLEtBQXVCYSxTQUEzQixFQUFzQztBQUNsQyxxQkFBSzdDLHlCQUFMLEdBQWlDLElBQWpDO0FBQ0EscUJBQUtoRCxTQUFMLENBQWU4YSx5QkFBZjtBQUNIO0FBQ0osU0Evb0JrQjs7QUFpcEJuQkMseUJBQWlCLFlBQVk7QUFDekIsMkJBQUtoWCxLQUFMLENBQVcsMENBQVg7QUFDSCxTQW5wQmtCOztBQXFwQm5CaVgscUJBQWEsWUFBWTtBQUNyQiwyQkFBS2pYLEtBQUwsQ0FBVyw0Q0FBWDtBQUNIO0FBdnBCa0IsS0FBdkI7QUF5cEJILENBM2lFRCIsImZpbGUiOiJyZmIuanMiLCJzb3VyY2VzQ29udGVudCI6WyIvKlxuICogbm9WTkM6IEhUTUw1IFZOQyBjbGllbnRcbiAqIENvcHlyaWdodCAoQykgMjAxMiBKb2VsIE1hcnRpblxuICogQ29weXJpZ2h0IChDKSAyMDE2IFNhbXVlbCBNYW5uZWhlZCBmb3IgQ2VuZGlvIEFCXG4gKiBMaWNlbnNlZCB1bmRlciBNUEwgMi4wIChzZWUgTElDRU5TRS50eHQpXG4gKlxuICogU2VlIFJFQURNRS5tZCBmb3IgdXNhZ2UgYW5kIGludGVncmF0aW9uIGluc3RydWN0aW9ucy5cbiAqXG4gKiBUSUdIVCBkZWNvZGVyIHBvcnRpb246XG4gKiAoYykgMjAxMiBNaWNoYWVsIFRpbmdsb2YsIEpvZSBCYWxheiwgTGVzIFBpZWNoIChNZXJjdXJpLmNhKVxuICovXG5cbmltcG9ydCBVdGlsIGZyb20gXCIuL3V0aWxcIjtcbmltcG9ydCBEaXNwbGF5IGZyb20gXCIuL2Rpc3BsYXlcIjtcbmltcG9ydCB7IEtleWJvYXJkLCBNb3VzZSB9IGZyb20gXCIuL2lucHV0L2RldmljZXNcIlxuaW1wb3J0IFdlYnNvY2sgZnJvbSBcIi4vd2Vic29ja1wiXG5pbXBvcnQgQmFzZTY0IGZyb20gXCIuL2Jhc2U2NFwiO1xuaW1wb3J0IERFUyBmcm9tIFwiLi9kZXNcIjtcbmltcG9ydCBLZXlUYWJsZSBmcm9tIFwiLi9pbnB1dC9rZXlzeW1cIjtcbmltcG9ydCBYdFNjYW5jb2RlIGZyb20gXCIuL2lucHV0L3h0c2NhbmNvZGVzXCI7XG5pbXBvcnQgSW5mbGF0b3IgZnJvbSBcIi4vaW5mbGF0b3IubW9kXCI7XG5cbi8qanNsaW50IHdoaXRlOiBmYWxzZSwgYnJvd3NlcjogdHJ1ZSAqL1xuLypnbG9iYWwgd2luZG93LCBVdGlsLCBEaXNwbGF5LCBLZXlib2FyZCwgTW91c2UsIFdlYnNvY2ssIFdlYnNvY2tfbmF0aXZlLCBCYXNlNjQsIERFUywgS2V5VGFibGUsIEluZmxhdG9yLCBYdFNjYW5jb2RlICovXG5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIFJGQihkZWZhdWx0cykge1xuICAgIFwidXNlIHN0cmljdFwiO1xuICAgIGlmICghZGVmYXVsdHMpIHtcbiAgICAgICAgZGVmYXVsdHMgPSB7fTtcbiAgICB9XG5cbiAgICB0aGlzLl9yZmJfaG9zdCA9ICcnO1xuICAgIHRoaXMuX3JmYl9wb3J0ID0gNTkwMDtcbiAgICB0aGlzLl9yZmJfcGFzc3dvcmQgPSAnJztcbiAgICB0aGlzLl9yZmJfcGF0aCA9ICcnO1xuXG4gICAgdGhpcy5fcmZiX3N0YXRlID0gJ2Rpc2Nvbm5lY3RlZCc7XG4gICAgdGhpcy5fcmZiX3ZlcnNpb24gPSAwO1xuICAgIHRoaXMuX3JmYl9tYXhfdmVyc2lvbiA9IDMuODtcbiAgICB0aGlzLl9yZmJfYXV0aF9zY2hlbWUgPSAnJztcblxuICAgIHRoaXMuX3JmYl90aWdodHZuYyA9IGZhbHNlO1xuICAgIHRoaXMuX3JmYl94dnBfdmVyID0gMDtcblxuICAgIC8vIEluIHByZWZlcmVuY2Ugb3JkZXJcbiAgICB0aGlzLl9lbmNvZGluZ3MgPSBbXG4gICAgICAgIFsnQ09QWVJFQ1QnLCAgICAgICAgICAgICAweDAxIF0sXG4gICAgICAgIFsnVElHSFQnLCAgICAgICAgICAgICAgICAweDA3IF0sXG4gICAgICAgIFsnVElHSFRfUE5HJywgICAgICAgICAgICAtMjYwIF0sXG4gICAgICAgIFsnSEVYVElMRScsICAgICAgICAgICAgICAweDA1IF0sXG4gICAgICAgIFsnUlJFJywgICAgICAgICAgICAgICAgICAweDAyIF0sXG4gICAgICAgIFsnUkFXJywgICAgICAgICAgICAgICAgICAweDAwIF0sXG5cbiAgICAgICAgLy8gUHN1ZWRvLWVuY29kaW5nIHNldHRpbmdzXG5cbiAgICAgICAgLy9bJ0pQRUdfcXVhbGl0eV9sbycsICAgICAtMzIgXSxcbiAgICAgICAgWydKUEVHX3F1YWxpdHlfbWVkJywgICAgICAtMjYgXSxcbiAgICAgICAgLy9bJ0pQRUdfcXVhbGl0eV9oaScsICAgICAtMjMgXSxcbiAgICAgICAgLy9bJ2NvbXByZXNzX2xvJywgICAgICAgIC0yNTUgXSxcbiAgICAgICAgWydjb21wcmVzc19oaScsICAgICAgICAgIC0yNDcgXSxcblxuICAgICAgICBbJ0Rlc2t0b3BTaXplJywgICAgICAgICAgLTIyMyBdLFxuICAgICAgICBbJ2xhc3RfcmVjdCcsICAgICAgICAgICAgLTIyNCBdLFxuICAgICAgICBbJ0N1cnNvcicsICAgICAgICAgICAgICAgLTIzOSBdLFxuICAgICAgICBbJ1FFTVVFeHRlbmRlZEtleUV2ZW50JywgLTI1OCBdLFxuICAgICAgICBbJ0V4dGVuZGVkRGVza3RvcFNpemUnLCAgLTMwOCBdLFxuICAgICAgICBbJ3h2cCcsICAgICAgICAgICAgICAgICAgLTMwOSBdLFxuICAgICAgICBbJ0ZlbmNlJywgICAgICAgICAgICAgICAgLTMxMiBdLFxuICAgICAgICBbJ0NvbnRpbnVvdXNVcGRhdGVzJywgICAgLTMxMyBdXG4gICAgXTtcblxuICAgIHRoaXMuX2VuY0hhbmRsZXJzID0ge307XG4gICAgdGhpcy5fZW5jTmFtZXMgPSB7fTtcbiAgICB0aGlzLl9lbmNTdGF0cyA9IHt9O1xuXG4gICAgdGhpcy5fc29jayA9IG51bGw7ICAgICAgICAgICAgICAvLyBXZWJzb2NrIG9iamVjdFxuICAgIHRoaXMuX2Rpc3BsYXkgPSBudWxsOyAgICAgICAgICAgLy8gRGlzcGxheSBvYmplY3RcbiAgICB0aGlzLl9rZXlib2FyZCA9IG51bGw7ICAgICAgICAgIC8vIEtleWJvYXJkIGlucHV0IGhhbmRsZXIgb2JqZWN0XG4gICAgdGhpcy5fbW91c2UgPSBudWxsOyAgICAgICAgICAgICAvLyBNb3VzZSBpbnB1dCBoYW5kbGVyIG9iamVjdFxuICAgIHRoaXMuX2Rpc2Nvbm5UaW1lciA9IG51bGw7ICAgICAgLy8gZGlzY29ubmVjdGlvbiB0aW1lclxuICAgIHRoaXMuX21zZ1RpbWVyID0gbnVsbDsgICAgICAgICAgLy8gcXVldWVkIGhhbmRsZV9tc2cgdGltZXJcblxuICAgIHRoaXMuX3N1cHBvcnRzRmVuY2UgPSBmYWxzZTtcblxuICAgIHRoaXMuX3N1cHBvcnRzQ29udGludW91c1VwZGF0ZXMgPSBmYWxzZTtcbiAgICB0aGlzLl9lbmFibGVkQ29udGludW91c1VwZGF0ZXMgPSBmYWxzZTtcblxuICAgIC8vIEZyYW1lIGJ1ZmZlciB1cGRhdGUgc3RhdGVcbiAgICB0aGlzLl9GQlUgPSB7XG4gICAgICAgIHJlY3RzOiAwLFxuICAgICAgICBzdWJyZWN0czogMCwgICAgICAgICAgICAvLyBSUkVcbiAgICAgICAgbGluZXM6IDAsICAgICAgICAgICAgICAgLy8gUkFXXG4gICAgICAgIHRpbGVzOiAwLCAgICAgICAgICAgICAgIC8vIEhFWFRJTEVcbiAgICAgICAgYnl0ZXM6IDAsXG4gICAgICAgIHg6IDAsXG4gICAgICAgIHk6IDAsXG4gICAgICAgIHdpZHRoOiAwLFxuICAgICAgICBoZWlnaHQ6IDAsXG4gICAgICAgIGVuY29kaW5nOiAwLFxuICAgICAgICBzdWJlbmNvZGluZzogLTEsXG4gICAgICAgIGJhY2tncm91bmQ6IG51bGwsXG4gICAgICAgIHpsaWI6IFtdICAgICAgICAgICAgICAgIC8vIFRJR0hUIHpsaWIgc3RyZWFtc1xuICAgIH07XG5cbiAgICB0aGlzLl9mYl9CcHAgPSA0O1xuICAgIHRoaXMuX2ZiX2RlcHRoID0gMztcbiAgICB0aGlzLl9mYl93aWR0aCA9IDA7XG4gICAgdGhpcy5fZmJfaGVpZ2h0ID0gMDtcbiAgICB0aGlzLl9mYl9uYW1lID0gXCJcIjtcblxuICAgIHRoaXMuX2Rlc3RCdWZmID0gbnVsbDtcbiAgICB0aGlzLl9wYWxldHRlQnVmZiA9IG5ldyBVaW50OEFycmF5KDEwMjQpOyAgLy8gMjU2ICogNCAobWF4IHBhbGV0dGUgc2l6ZSAqIG1heCBieXRlcy1wZXItcGl4ZWwpXG5cbiAgICB0aGlzLl9ycmVfY2h1bmtfc3ogPSAxMDA7XG5cbiAgICB0aGlzLl90aW1pbmcgPSB7XG4gICAgICAgIGxhc3RfZmJ1OiAwLFxuICAgICAgICBmYnVfdG90YWw6IDAsXG4gICAgICAgIGZidV90b3RhbF9jbnQ6IDAsXG4gICAgICAgIGZ1bGxfZmJ1X3RvdGFsOiAwLFxuICAgICAgICBmdWxsX2ZidV9jbnQ6IDAsXG5cbiAgICAgICAgZmJ1X3J0X3N0YXJ0OiAwLFxuICAgICAgICBmYnVfcnRfdG90YWw6IDAsXG4gICAgICAgIGZidV9ydF9jbnQ6IDAsXG4gICAgICAgIHBpeGVsczogMFxuICAgIH07XG5cbiAgICB0aGlzLl9zdXBwb3J0c1NldERlc2t0b3BTaXplID0gZmFsc2U7XG4gICAgdGhpcy5fc2NyZWVuX2lkID0gMDtcbiAgICB0aGlzLl9zY3JlZW5fZmxhZ3MgPSAwO1xuXG4gICAgLy8gTW91c2Ugc3RhdGVcbiAgICB0aGlzLl9tb3VzZV9idXR0b25NYXNrID0gMDtcbiAgICB0aGlzLl9tb3VzZV9hcnIgPSBbXTtcbiAgICB0aGlzLl92aWV3cG9ydERyYWdnaW5nID0gZmFsc2U7XG4gICAgdGhpcy5fdmlld3BvcnREcmFnUG9zID0ge307XG4gICAgdGhpcy5fdmlld3BvcnRIYXNNb3ZlZCA9IGZhbHNlO1xuXG4gICAgLy8gUUVNVSBFeHRlbmRlZCBLZXkgRXZlbnQgc3VwcG9ydCAtIGRlZmF1bHQgdG8gZmFsc2VcbiAgICB0aGlzLl9xZW11RXh0S2V5RXZlbnRTdXBwb3J0ZWQgPSBmYWxzZTtcblxuICAgIC8vIHNldCB0aGUgZGVmYXVsdCB2YWx1ZSBvbiB1c2VyLWZhY2luZyBwcm9wZXJ0aWVzXG4gICAgVXRpbC5zZXRfZGVmYXVsdHModGhpcywgZGVmYXVsdHMsIHtcbiAgICAgICAgJ3RhcmdldCc6ICdudWxsJywgICAgICAgICAgICAgICAgICAgICAgIC8vIFZOQyBkaXNwbGF5IHJlbmRlcmluZyBDYW52YXMgb2JqZWN0XG4gICAgICAgICdmb2N1c0NvbnRhaW5lcic6IGRvY3VtZW50LCAgICAgICAgICAgICAvLyBET00gZWxlbWVudCB0aGF0IGNhcHR1cmVzIGtleWJvYXJkIGlucHV0XG4gICAgICAgICdlbmNyeXB0JzogZmFsc2UsICAgICAgICAgICAgICAgICAgICAgICAvLyBVc2UgVExTL1NTTC93c3MgZW5jcnlwdGlvblxuICAgICAgICAndHJ1ZV9jb2xvcic6IHRydWUsICAgICAgICAgICAgICAgICAgICAgLy8gUmVxdWVzdCB0cnVlIGNvbG9yIHBpeGVsIGRhdGFcbiAgICAgICAgJ2xvY2FsX2N1cnNvcic6IGZhbHNlLCAgICAgICAgICAgICAgICAgIC8vIFJlcXVlc3QgbG9jYWxseSByZW5kZXJlZCBjdXJzb3JcbiAgICAgICAgJ3NoYXJlZCc6IHRydWUsICAgICAgICAgICAgICAgICAgICAgICAgIC8vIFJlcXVlc3Qgc2hhcmVkIG1vZGVcbiAgICAgICAgJ3ZpZXdfb25seSc6IGZhbHNlLCAgICAgICAgICAgICAgICAgICAgIC8vIERpc2FibGUgY2xpZW50IG1vdXNlL2tleWJvYXJkXG4gICAgICAgICd4dnBfcGFzc3dvcmRfc2VwJzogJ0AnLCAgICAgICAgICAgICAgICAvLyBTZXBhcmF0b3IgZm9yIFhWUCBwYXNzd29yZCBmaWVsZHNcbiAgICAgICAgJ2Rpc2Nvbm5lY3RUaW1lb3V0JzogMywgICAgICAgICAgICAgICAgIC8vIFRpbWUgKHMpIHRvIHdhaXQgZm9yIGRpc2Nvbm5lY3Rpb25cbiAgICAgICAgJ3dzUHJvdG9jb2xzJzogWydiaW5hcnknXSwgICAgICAgICAgICAgIC8vIFByb3RvY29scyB0byB1c2UgaW4gdGhlIFdlYlNvY2tldCBjb25uZWN0aW9uXG4gICAgICAgICdyZXBlYXRlcklEJzogJycsICAgICAgICAgICAgICAgICAgICAgICAvLyBbVWx0cmFWTkNdIFJlcGVhdGVySUQgdG8gY29ubmVjdCB0b1xuICAgICAgICAndmlld3BvcnREcmFnJzogZmFsc2UsICAgICAgICAgICAgICAgICAgLy8gTW92ZSB0aGUgdmlld3BvcnQgb24gbW91c2UgZHJhZ3NcblxuICAgICAgICAvLyBDYWxsYmFjayBmdW5jdGlvbnNcbiAgICAgICAgJ29uVXBkYXRlU3RhdGUnOiBmdW5jdGlvbiAoKSB7IH0sICAgICAgIC8vIG9uVXBkYXRlU3RhdGUocmZiLCBzdGF0ZSwgb2xkc3RhdGUsIHN0YXR1c01zZyk6IHN0YXRlIHVwZGF0ZS9jaGFuZ2VcbiAgICAgICAgJ29uUGFzc3dvcmRSZXF1aXJlZCc6IGZ1bmN0aW9uICgpIHsgfSwgIC8vIG9uUGFzc3dvcmRSZXF1aXJlZChyZmIpOiBWTkMgcGFzc3dvcmQgaXMgcmVxdWlyZWRcbiAgICAgICAgJ29uQ2xpcGJvYXJkJzogZnVuY3Rpb24gKCkgeyB9LCAgICAgICAgIC8vIG9uQ2xpcGJvYXJkKHJmYiwgdGV4dCk6IFJGQiBjbGlwYm9hcmQgY29udGVudHMgcmVjZWl2ZWRcbiAgICAgICAgJ29uQmVsbCc6IGZ1bmN0aW9uICgpIHsgfSwgICAgICAgICAgICAgIC8vIG9uQmVsbChyZmIpOiBSRkIgQmVsbCBtZXNzYWdlIHJlY2VpdmVkXG4gICAgICAgICdvbkZCVVJlY2VpdmUnOiBmdW5jdGlvbiAoKSB7IH0sICAgICAgICAvLyBvbkZCVVJlY2VpdmUocmZiLCBmYnUpOiBSRkIgRkJVIHJlY2VpdmVkIGJ1dCBub3QgeWV0IHByb2Nlc3NlZFxuICAgICAgICAnb25GQlVDb21wbGV0ZSc6IGZ1bmN0aW9uICgpIHsgfSwgICAgICAgLy8gb25GQlVDb21wbGV0ZShyZmIsIGZidSk6IFJGQiBGQlUgcmVjZWl2ZWQgYW5kIHByb2Nlc3NlZFxuICAgICAgICAnb25GQlJlc2l6ZSc6IGZ1bmN0aW9uICgpIHsgfSwgICAgICAgICAgLy8gb25GQlJlc2l6ZShyZmIsIHdpZHRoLCBoZWlnaHQpOiBmcmFtZSBidWZmZXIgcmVzaXplZFxuICAgICAgICAnb25EZXNrdG9wTmFtZSc6IGZ1bmN0aW9uICgpIHsgfSwgICAgICAgLy8gb25EZXNrdG9wTmFtZShyZmIsIG5hbWUpOiBkZXNrdG9wIG5hbWUgcmVjZWl2ZWRcbiAgICAgICAgJ29uWHZwSW5pdCc6IGZ1bmN0aW9uICgpIHsgfSAgICAgICAgICAgIC8vIG9uWHZwSW5pdCh2ZXJzaW9uKTogWFZQIGV4dGVuc2lvbnMgYWN0aXZlIGZvciB0aGlzIGNvbm5lY3Rpb25cbiAgICB9KTtcblxuICAgIC8vIG1haW4gc2V0dXBcbiAgICBVdGlsLkRlYnVnKFwiPj4gUkZCLmNvbnN0cnVjdG9yXCIpO1xuXG4gICAgLy8gcG9wdWxhdGUgZW5jSGFuZGxlcnMgd2l0aCBib3VuZCB2ZXJzaW9uc1xuICAgIE9iamVjdC5rZXlzKFJGQi5lbmNvZGluZ0hhbmRsZXJzKS5mb3JFYWNoKGZ1bmN0aW9uIChlbmNOYW1lKSB7XG4gICAgICAgIHRoaXMuX2VuY0hhbmRsZXJzW2VuY05hbWVdID0gUkZCLmVuY29kaW5nSGFuZGxlcnNbZW5jTmFtZV0uYmluZCh0aGlzKTtcbiAgICB9LmJpbmQodGhpcykpO1xuXG4gICAgLy8gQ3JlYXRlIGxvb2t1cCB0YWJsZXMgYmFzZWQgb24gZW5jb2RpbmcgbnVtYmVyXG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLl9lbmNvZGluZ3MubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgdGhpcy5fZW5jSGFuZGxlcnNbdGhpcy5fZW5jb2RpbmdzW2ldWzFdXSA9IHRoaXMuX2VuY0hhbmRsZXJzW3RoaXMuX2VuY29kaW5nc1tpXVswXV07XG4gICAgICAgIHRoaXMuX2VuY05hbWVzW3RoaXMuX2VuY29kaW5nc1tpXVsxXV0gPSB0aGlzLl9lbmNvZGluZ3NbaV1bMF07XG4gICAgICAgIHRoaXMuX2VuY1N0YXRzW3RoaXMuX2VuY29kaW5nc1tpXVsxXV0gPSBbMCwgMF07XG4gICAgfVxuXG4gICAgLy8gTkI6IG5vdGhpbmcgdGhhdCBuZWVkcyBleHBsaWNpdCB0ZWFyZG93biBzaG91bGQgYmUgZG9uZVxuICAgIC8vIGJlZm9yZSB0aGlzIHBvaW50LCBzaW5jZSB0aGlzIGNhbiB0aHJvdyBhbiBleGNlcHRpb25cbiAgICB0cnkge1xuICAgICAgICB0aGlzLl9kaXNwbGF5ID0gbmV3IERpc3BsYXkoe3RhcmdldDogdGhpcy5fdGFyZ2V0fSk7XG4gICAgfSBjYXRjaCAoZXhjKSB7XG4gICAgICAgIFV0aWwuRXJyb3IoXCJEaXNwbGF5IGV4Y2VwdGlvbjogXCIgKyBleGMpO1xuICAgICAgICB0aHJvdyBleGM7XG4gICAgfVxuXG4gICAgdGhpcy5fa2V5Ym9hcmQgPSBuZXcgS2V5Ym9hcmQoe3RhcmdldDogdGhpcy5fZm9jdXNDb250YWluZXIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uS2V5UHJlc3M6IHRoaXMuX2hhbmRsZUtleVByZXNzLmJpbmQodGhpcyl9KTtcblxuICAgIHRoaXMuX21vdXNlID0gbmV3IE1vdXNlKHt0YXJnZXQ6IHRoaXMuX3RhcmdldCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb25Nb3VzZUJ1dHRvbjogdGhpcy5faGFuZGxlTW91c2VCdXR0b24uYmluZCh0aGlzKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb25Nb3VzZU1vdmU6IHRoaXMuX2hhbmRsZU1vdXNlTW92ZS5iaW5kKHRoaXMpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICBub3RpZnk6IHRoaXMuX2tleWJvYXJkLnN5bmMuYmluZCh0aGlzLl9rZXlib2FyZCl9KTtcblxuICAgIHRoaXMuX3NvY2sgPSBuZXcgV2Vic29jaygpO1xuICAgIHRoaXMuX3NvY2sub24oJ21lc3NhZ2UnLCB0aGlzLl9oYW5kbGVfbWVzc2FnZS5iaW5kKHRoaXMpKTtcbiAgICB0aGlzLl9zb2NrLm9uKCdvcGVuJywgZnVuY3Rpb24gKCkge1xuICAgICAgICBpZiAodGhpcy5fcmZiX3N0YXRlID09PSAnY29ubmVjdCcpIHtcbiAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdQcm90b2NvbFZlcnNpb24nLCBcIlN0YXJ0aW5nIFZOQyBoYW5kc2hha2VcIik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLl9mYWlsKFwiR290IHVuZXhwZWN0ZWQgV2ViU29ja2V0IGNvbm5lY3Rpb25cIik7XG4gICAgICAgIH1cbiAgICB9LmJpbmQodGhpcykpO1xuICAgIHRoaXMuX3NvY2sub24oJ2Nsb3NlJywgZnVuY3Rpb24gKGUpIHtcbiAgICAgICAgVXRpbC5XYXJuKFwiV2ViU29ja2V0IG9uLWNsb3NlIGV2ZW50XCIpO1xuICAgICAgICB2YXIgbXNnID0gXCJcIjtcbiAgICAgICAgaWYgKGUuY29kZSkge1xuICAgICAgICAgICAgbXNnID0gXCIgKGNvZGU6IFwiICsgZS5jb2RlO1xuICAgICAgICAgICAgaWYgKGUucmVhc29uKSB7XG4gICAgICAgICAgICAgICAgbXNnICs9IFwiLCByZWFzb246IFwiICsgZS5yZWFzb247XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBtc2cgKz0gXCIpXCI7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRoaXMuX3JmYl9zdGF0ZSA9PT0gJ2Rpc2Nvbm5lY3QnKSB7XG4gICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgnZGlzY29ubmVjdGVkJywgJ1ZOQyBkaXNjb25uZWN0ZWQnICsgbXNnKTtcbiAgICAgICAgfSBlbHNlIGlmICh0aGlzLl9yZmJfc3RhdGUgPT09ICdQcm90b2NvbFZlcnNpb24nKSB7XG4gICAgICAgICAgICB0aGlzLl9mYWlsKCdGYWlsZWQgdG8gY29ubmVjdCB0byBzZXJ2ZXInICsgbXNnKTtcbiAgICAgICAgfSBlbHNlIGlmICh0aGlzLl9yZmJfc3RhdGUgaW4geydmYWlsZWQnOiAxLCAnZGlzY29ubmVjdGVkJzogMX0pIHtcbiAgICAgICAgICAgIFV0aWwuRXJyb3IoXCJSZWNlaXZlZCBvbmNsb3NlIHdoaWxlIGRpc2Nvbm5lY3RlZFwiICsgbXNnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuX2ZhaWwoXCJTZXJ2ZXIgZGlzY29ubmVjdGVkXCIgKyBtc2cpO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuX3NvY2sub2ZmKCdjbG9zZScpO1xuICAgIH0uYmluZCh0aGlzKSk7XG4gICAgdGhpcy5fc29jay5vbignZXJyb3InLCBmdW5jdGlvbiAoZSkge1xuICAgICAgICBVdGlsLldhcm4oXCJXZWJTb2NrZXQgb24tZXJyb3IgZXZlbnRcIik7XG4gICAgfSk7XG5cbiAgICB0aGlzLl9pbml0X3ZhcnMoKTtcblxuICAgIHZhciBybW9kZSA9IHRoaXMuX2Rpc3BsYXkuZ2V0X3JlbmRlcl9tb2RlKCk7XG4gICAgVXRpbC5JbmZvKFwiVXNpbmcgbmF0aXZlIFdlYlNvY2tldHNcIik7XG4gICAgdGhpcy5fdXBkYXRlU3RhdGUoJ2xvYWRlZCcsICdub1ZOQyByZWFkeTogbmF0aXZlIFdlYlNvY2tldHMsICcgKyBybW9kZSk7XG5cbiAgICBVdGlsLkRlYnVnKFwiPDwgUkZCLmNvbnN0cnVjdG9yXCIpO1xufTtcblxuKGZ1bmN0aW9uKCkge1xuICAgIFJGQi5wcm90b3R5cGUgPSB7XG4gICAgICAgIC8vIFB1YmxpYyBtZXRob2RzXG4gICAgICAgIGNvbm5lY3Q6IGZ1bmN0aW9uIChob3N0LCBwb3J0LCBwYXNzd29yZCwgcGF0aCkge1xuICAgICAgICAgICAgdGhpcy5fcmZiX2hvc3QgPSBob3N0O1xuICAgICAgICAgICAgdGhpcy5fcmZiX3BvcnQgPSBwb3J0O1xuICAgICAgICAgICAgdGhpcy5fcmZiX3Bhc3N3b3JkID0gKHBhc3N3b3JkICE9PSB1bmRlZmluZWQpID8gcGFzc3dvcmQgOiBcIlwiO1xuICAgICAgICAgICAgdGhpcy5fcmZiX3BhdGggPSAocGF0aCAhPT0gdW5kZWZpbmVkKSA/IHBhdGggOiBcIlwiO1xuXG4gICAgICAgICAgICBpZiAoIXRoaXMuX3JmYl9ob3N0IHx8ICF0aGlzLl9yZmJfcG9ydCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiTXVzdCBzZXQgaG9zdCBhbmQgcG9ydFwiKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ2Nvbm5lY3QnKTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIGRpc2Nvbm5lY3Q6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdkaXNjb25uZWN0JywgJ0Rpc2Nvbm5lY3RpbmcnKTtcbiAgICAgICAgICAgIHRoaXMuX3NvY2sub2ZmKCdlcnJvcicpO1xuICAgICAgICAgICAgdGhpcy5fc29jay5vZmYoJ21lc3NhZ2UnKTtcbiAgICAgICAgICAgIHRoaXMuX3NvY2sub2ZmKCdvcGVuJyk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgc2VuZFBhc3N3b3JkOiBmdW5jdGlvbiAocGFzc3dkKSB7XG4gICAgICAgICAgICB0aGlzLl9yZmJfcGFzc3dvcmQgPSBwYXNzd2Q7XG4gICAgICAgICAgICB0aGlzLl9yZmJfc3RhdGUgPSAnQXV0aGVudGljYXRpb24nO1xuICAgICAgICAgICAgc2V0VGltZW91dCh0aGlzLl9pbml0X21zZy5iaW5kKHRoaXMpLCAwKTtcbiAgICAgICAgfSxcblxuICAgICAgICBzZW5kQ3RybEFsdERlbDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3JmYl9zdGF0ZSAhPT0gJ25vcm1hbCcgfHwgdGhpcy5fdmlld19vbmx5KSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgVXRpbC5JbmZvKFwiU2VuZGluZyBDdHJsLUFsdC1EZWxcIik7XG5cbiAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5rZXlFdmVudCh0aGlzLl9zb2NrLCBLZXlUYWJsZS5YS19Db250cm9sX0wsIDEpO1xuICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmtleUV2ZW50KHRoaXMuX3NvY2ssIEtleVRhYmxlLlhLX0FsdF9MLCAxKTtcbiAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5rZXlFdmVudCh0aGlzLl9zb2NrLCBLZXlUYWJsZS5YS19EZWxldGUsIDEpO1xuICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmtleUV2ZW50KHRoaXMuX3NvY2ssIEtleVRhYmxlLlhLX0RlbGV0ZSwgMCk7XG4gICAgICAgICAgICBSRkIubWVzc2FnZXMua2V5RXZlbnQodGhpcy5fc29jaywgS2V5VGFibGUuWEtfQWx0X0wsIDApO1xuICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmtleUV2ZW50KHRoaXMuX3NvY2ssIEtleVRhYmxlLlhLX0NvbnRyb2xfTCwgMCk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICB4dnBPcDogZnVuY3Rpb24gKHZlciwgb3ApIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9yZmJfeHZwX3ZlciA8IHZlcikgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgIFV0aWwuSW5mbyhcIlNlbmRpbmcgWFZQIG9wZXJhdGlvbiBcIiArIG9wICsgXCIgKHZlcnNpb24gXCIgKyB2ZXIgKyBcIilcIik7XG4gICAgICAgICAgICB0aGlzLl9zb2NrLnNlbmRfc3RyaW5nKFwiXFx4RkFcXHgwMFwiICsgU3RyaW5nLmZyb21DaGFyQ29kZSh2ZXIpICsgU3RyaW5nLmZyb21DaGFyQ29kZShvcCkpO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgeHZwU2h1dGRvd246IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLnh2cE9wKDEsIDIpO1xuICAgICAgICB9LFxuXG4gICAgICAgIHh2cFJlYm9vdDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMueHZwT3AoMSwgMyk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgeHZwUmVzZXQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLnh2cE9wKDEsIDQpO1xuICAgICAgICB9LFxuXG4gICAgICAgIC8vIFNlbmQgYSBrZXkgcHJlc3MuIElmICdkb3duJyBpcyBub3Qgc3BlY2lmaWVkIHRoZW4gc2VuZCBhIGRvd24ga2V5XG4gICAgICAgIC8vIGZvbGxvd2VkIGJ5IGFuIHVwIGtleS5cbiAgICAgICAgc2VuZEtleTogZnVuY3Rpb24gKGNvZGUsIGRvd24pIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9yZmJfc3RhdGUgIT09IFwibm9ybWFsXCIgfHwgdGhpcy5fdmlld19vbmx5KSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgaWYgKHR5cGVvZiBkb3duICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgICAgICAgIFV0aWwuSW5mbyhcIlNlbmRpbmcga2V5IGNvZGUgKFwiICsgKGRvd24gPyBcImRvd25cIiA6IFwidXBcIikgKyBcIik6IFwiICsgY29kZSk7XG4gICAgICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmtleUV2ZW50KHRoaXMuX3NvY2ssIGNvZGUsIGRvd24gPyAxIDogMCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIFV0aWwuSW5mbyhcIlNlbmRpbmcga2V5IGNvZGUgKGRvd24gKyB1cCk6IFwiICsgY29kZSk7XG4gICAgICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmtleUV2ZW50KHRoaXMuX3NvY2ssIGNvZGUsIDEpO1xuICAgICAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5rZXlFdmVudCh0aGlzLl9zb2NrLCBjb2RlLCAwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIGNsaXBib2FyZFBhc3RlRnJvbTogZnVuY3Rpb24gKHRleHQpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9yZmJfc3RhdGUgIT09ICdub3JtYWwnKSB7IHJldHVybjsgfVxuICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmNsaWVudEN1dFRleHQodGhpcy5fc29jaywgdGV4dCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gUmVxdWVzdHMgYSBjaGFuZ2Ugb2YgcmVtb3RlIGRlc2t0b3Agc2l6ZS4gVGhpcyBtZXNzYWdlIGlzIGFuIGV4dGVuc2lvblxuICAgICAgICAvLyBhbmQgbWF5IG9ubHkgYmUgc2VudCBpZiB3ZSBoYXZlIHJlY2VpdmVkIGFuIEV4dGVuZGVkRGVza3RvcFNpemUgbWVzc2FnZVxuICAgICAgICByZXF1ZXN0RGVza3RvcFNpemU6IGZ1bmN0aW9uICh3aWR0aCwgaGVpZ2h0KSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fcmZiX3N0YXRlICE9PSBcIm5vcm1hbFwiKSB7IHJldHVybjsgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5fc3VwcG9ydHNTZXREZXNrdG9wU2l6ZSkge1xuICAgICAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5zZXREZXNrdG9wU2l6ZSh0aGlzLl9zb2NrLCB3aWR0aCwgaGVpZ2h0LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9zY3JlZW5faWQsIHRoaXMuX3NjcmVlbl9mbGFncyk7XG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5mbHVzaCgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG5cbiAgICAgICAgLy8gUHJpdmF0ZSBtZXRob2RzXG5cbiAgICAgICAgX2Nvbm5lY3Q6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIFV0aWwuRGVidWcoXCI+PiBSRkIuY29ubmVjdFwiKTtcblxuICAgICAgICAgICAgdmFyIHVyaTtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgVXNpbmdTb2NrZXRJTyAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgICAgICB1cmkgPSAnaHR0cCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHVyaSA9IHRoaXMuX2VuY3J5cHQgPyAnd3NzJyA6ICd3cyc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHVyaSArPSAnOi8vJyArIHRoaXMuX3JmYl9ob3N0ICsgJzonICsgdGhpcy5fcmZiX3BvcnQgKyAnLycgKyB0aGlzLl9yZmJfcGF0aDtcbiAgICAgICAgICAgIFV0aWwuSW5mbyhcImNvbm5lY3RpbmcgdG8gXCIgKyB1cmkpO1xuXG4gICAgICAgICAgICB0aGlzLl9zb2NrLm9wZW4odXJpLCB0aGlzLl93c1Byb3RvY29scyk7XG5cbiAgICAgICAgICAgIFV0aWwuRGVidWcoXCI8PCBSRkIuY29ubmVjdFwiKTtcbiAgICAgICAgfSxcblxuICAgICAgICBfaW5pdF92YXJzOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAvLyByZXNldCBzdGF0ZVxuICAgICAgICAgICAgdGhpcy5fRkJVLnJlY3RzICAgICAgICA9IDA7XG4gICAgICAgICAgICB0aGlzLl9GQlUuc3VicmVjdHMgICAgID0gMDsgIC8vIFJSRSBhbmQgSEVYVElMRVxuICAgICAgICAgICAgdGhpcy5fRkJVLmxpbmVzICAgICAgICA9IDA7ICAvLyBSQVdcbiAgICAgICAgICAgIHRoaXMuX0ZCVS50aWxlcyAgICAgICAgPSAwOyAgLy8gSEVYVElMRVxuICAgICAgICAgICAgdGhpcy5fRkJVLnpsaWJzICAgICAgICA9IFtdOyAvLyBUSUdIVCB6bGliIGVuY29kZXJzXG4gICAgICAgICAgICB0aGlzLl9tb3VzZV9idXR0b25NYXNrID0gMDtcbiAgICAgICAgICAgIHRoaXMuX21vdXNlX2FyciAgICAgICAgPSBbXTtcbiAgICAgICAgICAgIHRoaXMuX3JmYl90aWdodHZuYyAgICAgPSBmYWxzZTtcblxuICAgICAgICAgICAgLy8gQ2xlYXIgdGhlIHBlciBjb25uZWN0aW9uIGVuY29kaW5nIHN0YXRzXG4gICAgICAgICAgICB2YXIgaTtcbiAgICAgICAgICAgIGZvciAoaSA9IDA7IGkgPCB0aGlzLl9lbmNvZGluZ3MubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9lbmNTdGF0c1t0aGlzLl9lbmNvZGluZ3NbaV1bMV1dWzBdID0gMDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZm9yIChpID0gMDsgaSA8IDQ7IGkrKykge1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS56bGlic1tpXSA9IG5ldyBJbmZsYXRvci5JbmZsYXRlKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgX3ByaW50X3N0YXRzOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBVdGlsLkluZm8oXCJFbmNvZGluZyBzdGF0cyBmb3IgdGhpcyBjb25uZWN0aW9uOlwiKTtcbiAgICAgICAgICAgIHZhciBpLCBzO1xuICAgICAgICAgICAgZm9yIChpID0gMDsgaSA8IHRoaXMuX2VuY29kaW5ncy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgICAgIHMgPSB0aGlzLl9lbmNTdGF0c1t0aGlzLl9lbmNvZGluZ3NbaV1bMV1dO1xuICAgICAgICAgICAgICAgIGlmIChzWzBdICsgc1sxXSA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiICAgIFwiICsgdGhpcy5fZW5jb2RpbmdzW2ldWzBdICsgXCI6IFwiICsgc1swXSArIFwiIHJlY3RzXCIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgVXRpbC5JbmZvKFwiRW5jb2Rpbmcgc3RhdHMgc2luY2UgcGFnZSBsb2FkOlwiKTtcbiAgICAgICAgICAgIGZvciAoaSA9IDA7IGkgPCB0aGlzLl9lbmNvZGluZ3MubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgICBzID0gdGhpcy5fZW5jU3RhdHNbdGhpcy5fZW5jb2RpbmdzW2ldWzFdXTtcbiAgICAgICAgICAgICAgICBVdGlsLkluZm8oXCIgICAgXCIgKyB0aGlzLl9lbmNvZGluZ3NbaV1bMF0gKyBcIjogXCIgKyBzWzFdICsgXCIgcmVjdHNcIik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2NsZWFudXBTb2NrZXQ6IGZ1bmN0aW9uIChzdGF0ZSkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX21zZ1RpbWVyKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJJbnRlcnZhbCh0aGlzLl9tc2dUaW1lcik7XG4gICAgICAgICAgICAgICAgdGhpcy5fbXNnVGltZXIgPSBudWxsO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5fZGlzcGxheSAmJiB0aGlzLl9kaXNwbGF5LmdldF9jb250ZXh0KCkpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9rZXlib2FyZC51bmdyYWIoKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9tb3VzZS51bmdyYWIoKTtcbiAgICAgICAgICAgICAgICBpZiAoc3RhdGUgIT09ICdjb25uZWN0JyAmJiBzdGF0ZSAhPT0gJ2xvYWRlZCcpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5kZWZhdWx0Q3Vyc29yKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChVdGlsLmdldF9sb2dnaW5nKCkgIT09ICdkZWJ1ZycgfHwgc3RhdGUgPT09ICdsb2FkZWQnKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIFNob3cgbm9WTkMgbG9nbyBvbiBsb2FkIGFuZCB3aGVuIGRpc2Nvbm5lY3RlZCwgdW5sZXNzIGluXG4gICAgICAgICAgICAgICAgICAgIC8vIGRlYnVnIG1vZGVcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5jbGVhcigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhpcy5fc29jay5jbG9zZSgpO1xuICAgICAgICB9LFxuXG4gICAgICAgIC8qXG4gICAgICAgICAqIFBhZ2Ugc3RhdGVzOlxuICAgICAgICAgKiAgIGxvYWRlZCAgICAgICAtIHBhZ2UgbG9hZCwgZXF1aXZhbGVudCB0byBkaXNjb25uZWN0ZWRcbiAgICAgICAgICogICBkaXNjb25uZWN0ZWQgLSBpZGxlIHN0YXRlXG4gICAgICAgICAqICAgY29ubmVjdCAgICAgIC0gc3RhcnRpbmcgdG8gY29ubmVjdCAodG8gUHJvdG9jb2xWZXJzaW9uKVxuICAgICAgICAgKiAgIG5vcm1hbCAgICAgICAtIGNvbm5lY3RlZFxuICAgICAgICAgKiAgIGRpc2Nvbm5lY3QgICAtIHN0YXJ0aW5nIHRvIGRpc2Nvbm5lY3RcbiAgICAgICAgICogICBmYWlsZWQgICAgICAgLSBhYm5vcm1hbCBkaXNjb25uZWN0XG4gICAgICAgICAqICAgZmF0YWwgICAgICAgIC0gZmFpbGVkIHRvIGxvYWQgcGFnZSwgb3IgZmF0YWwgZXJyb3JcbiAgICAgICAgICpcbiAgICAgICAgICogUkZCIHByb3RvY29sIGluaXRpYWxpemF0aW9uIHN0YXRlczpcbiAgICAgICAgICogICBQcm90b2NvbFZlcnNpb25cbiAgICAgICAgICogICBTZWN1cml0eVxuICAgICAgICAgKiAgIEF1dGhlbnRpY2F0aW9uXG4gICAgICAgICAqICAgcGFzc3dvcmQgICAgIC0gd2FpdGluZyBmb3IgcGFzc3dvcmQsIG5vdCBwYXJ0IG9mIFJGQlxuICAgICAgICAgKiAgIFNlY3VyaXR5UmVzdWx0XG4gICAgICAgICAqICAgQ2xpZW50SW5pdGlhbGl6YXRpb24gLSBub3QgdHJpZ2dlcmVkIGJ5IHNlcnZlciBtZXNzYWdlXG4gICAgICAgICAqICAgU2VydmVySW5pdGlhbGl6YXRpb24gKHRvIG5vcm1hbClcbiAgICAgICAgICovXG4gICAgICAgIF91cGRhdGVTdGF0ZTogZnVuY3Rpb24gKHN0YXRlLCBzdGF0dXNNc2cpIHtcbiAgICAgICAgICAgIHZhciBvbGRzdGF0ZSA9IHRoaXMuX3JmYl9zdGF0ZTtcblxuICAgICAgICAgICAgaWYgKHN0YXRlID09PSBvbGRzdGF0ZSkge1xuICAgICAgICAgICAgICAgIC8vIEFscmVhZHkgaGVyZSwgaWdub3JlXG4gICAgICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIkFscmVhZHkgaW4gc3RhdGUgJ1wiICsgc3RhdGUgKyBcIicsIGlnbm9yaW5nXCIpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKlxuICAgICAgICAgICAgICogVGhlc2UgYXJlIGRpc2Nvbm5lY3RlZCBzdGF0ZXMuIEEgcHJldmlvdXMgY29ubmVjdCBtYXlcbiAgICAgICAgICAgICAqIGFzeW5jaHJvbm91c2x5IGNhdXNlIGEgY29ubmVjdGlvbiBzbyBtYWtlIHN1cmUgd2UgYXJlIGNsb3NlZC5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgaWYgKHN0YXRlIGluIHsnZGlzY29ubmVjdGVkJzogMSwgJ2xvYWRlZCc6IDEsICdjb25uZWN0JzogMSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgJ2Rpc2Nvbm5lY3QnOiAxLCAnZmFpbGVkJzogMSwgJ2ZhdGFsJzogMX0pIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9jbGVhbnVwU29ja2V0KHN0YXRlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG9sZHN0YXRlID09PSAnZmF0YWwnKSB7XG4gICAgICAgICAgICAgICAgVXRpbC5FcnJvcignRmF0YWwgZXJyb3IsIGNhbm5vdCBjb250aW51ZScpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YXIgY21zZyA9IHR5cGVvZihzdGF0dXNNc2cpICE9PSAndW5kZWZpbmVkJyA/IChcIiBNc2c6IFwiICsgc3RhdHVzTXNnKSA6IFwiXCI7XG4gICAgICAgICAgICB2YXIgZnVsbG1zZyA9IFwiTmV3IHN0YXRlICdcIiArIHN0YXRlICsgXCInLCB3YXMgJ1wiICsgb2xkc3RhdGUgKyBcIicuXCIgKyBjbXNnO1xuICAgICAgICAgICAgaWYgKHN0YXRlID09PSAnZmFpbGVkJyB8fCBzdGF0ZSA9PT0gJ2ZhdGFsJykge1xuICAgICAgICAgICAgICAgIFV0aWwuRXJyb3IoY21zZyk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIFV0aWwuV2FybihjbXNnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG9sZHN0YXRlID09PSAnZmFpbGVkJyAmJiBzdGF0ZSA9PT0gJ2Rpc2Nvbm5lY3RlZCcpIHtcbiAgICAgICAgICAgICAgICAvLyBkbyBkaXNjb25uZWN0IGFjdGlvbiwgYnV0IHN0YXkgaW4gZmFpbGVkIHN0YXRlXG4gICAgICAgICAgICAgICAgdGhpcy5fcmZiX3N0YXRlID0gJ2ZhaWxlZCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX3JmYl9zdGF0ZSA9IHN0YXRlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5fZGlzY29ublRpbWVyICYmIHRoaXMuX3JmYl9zdGF0ZSAhPT0gJ2Rpc2Nvbm5lY3QnKSB7XG4gICAgICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIkNsZWFyaW5nIGRpc2Nvbm5lY3QgdGltZXJcIik7XG4gICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHRoaXMuX2Rpc2Nvbm5UaW1lcik7XG4gICAgICAgICAgICAgICAgdGhpcy5fZGlzY29ublRpbWVyID0gbnVsbDtcbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLm9mZignY2xvc2UnKTsgIC8vIG1ha2Ugc3VyZSB3ZSBkb24ndCBnZXQgYSBkb3VibGUgZXZlbnRcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3dpdGNoIChzdGF0ZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgJ25vcm1hbCc6XG4gICAgICAgICAgICAgICAgICAgIGlmIChvbGRzdGF0ZSA9PT0gJ2Rpc2Nvbm5lY3RlZCcgfHwgb2xkc3RhdGUgPT09ICdmYWlsZWQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBVdGlsLkVycm9yKFwiSW52YWxpZCB0cmFuc2l0aW9uIGZyb20gJ2Rpc2Nvbm5lY3RlZCcgb3IgJ2ZhaWxlZCcgdG8gJ25vcm1hbCdcIik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdjb25uZWN0JzpcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5faW5pdF92YXJzKCk7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2Nvbm5lY3QoKTtcbiAgICAgICAgICAgICAgICAgICAgLy8gV2ViU29ja2V0Lm9ub3BlbiB0cmFuc2l0aW9ucyB0byAnUHJvdG9jb2xWZXJzaW9uJ1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2Rpc2Nvbm5lY3QnOlxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9kaXNjb25uVGltZXIgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZhaWwoXCJEaXNjb25uZWN0IHRpbWVvdXRcIik7XG4gICAgICAgICAgICAgICAgICAgIH0uYmluZCh0aGlzKSwgdGhpcy5fZGlzY29ubmVjdFRpbWVvdXQgKiAxMDAwKTtcblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcmludF9zdGF0cygpO1xuXG4gICAgICAgICAgICAgICAgICAgIC8vIFdlYlNvY2tldC5vbmNsb3NlIHRyYW5zaXRpb25zIHRvICdkaXNjb25uZWN0ZWQnXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnZmFpbGVkJzpcbiAgICAgICAgICAgICAgICAgICAgaWYgKG9sZHN0YXRlID09PSAnZGlzY29ubmVjdGVkJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgVXRpbC5FcnJvcihcIkludmFsaWQgdHJhbnNpdGlvbiBmcm9tICdkaXNjb25uZWN0ZWQnIHRvICdmYWlsZWQnXCIpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKG9sZHN0YXRlID09PSAnbm9ybWFsJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgVXRpbC5FcnJvcihcIkVycm9yIHdoaWxlIGNvbm5lY3RlZC5cIik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAob2xkc3RhdGUgPT09ICdpbml0Jykge1xuICAgICAgICAgICAgICAgICAgICAgICAgVXRpbC5FcnJvcihcIkVycm9yIHdoaWxlIGluaXRpYWxpemluZy5cIik7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvLyBNYWtlIHN1cmUgd2UgdHJhbnNpdGlvbiB0byBkaXNjb25uZWN0ZWRcbiAgICAgICAgICAgICAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgnZGlzY29ubmVjdGVkJyk7XG4gICAgICAgICAgICAgICAgICAgIH0uYmluZCh0aGlzKSwgNTApO1xuXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgLy8gTm8gc3RhdGUgY2hhbmdlIGFjdGlvbiB0byB0YWtlXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvbGRzdGF0ZSA9PT0gJ2ZhaWxlZCcgJiYgc3RhdGUgPT09ICdkaXNjb25uZWN0ZWQnKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fb25VcGRhdGVTdGF0ZSh0aGlzLCBzdGF0ZSwgb2xkc3RhdGUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9vblVwZGF0ZVN0YXRlKHRoaXMsIHN0YXRlLCBvbGRzdGF0ZSwgc3RhdHVzTXNnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBfZmFpbDogZnVuY3Rpb24gKG1zZykge1xuICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ2ZhaWxlZCcsIG1zZyk7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2hhbmRsZV9tZXNzYWdlOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUWxlbigpID09PSAwKSB7XG4gICAgICAgICAgICAgICAgVXRpbC5XYXJuKFwiaGFuZGxlX21lc3NhZ2UgY2FsbGVkIG9uIGFuIGVtcHR5IHJlY2VpdmUgcXVldWVcIik7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBzd2l0Y2ggKHRoaXMuX3JmYl9zdGF0ZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2Rpc2Nvbm5lY3RlZCc6XG4gICAgICAgICAgICAgICAgY2FzZSAnZmFpbGVkJzpcbiAgICAgICAgICAgICAgICAgICAgVXRpbC5FcnJvcihcIkdvdCBkYXRhIHdoaWxlIGRpc2Nvbm5lY3RlZFwiKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSAnbm9ybWFsJzpcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX25vcm1hbF9tc2coKSAmJiB0aGlzLl9zb2NrLnJRbGVuKCkgPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyB0cnVlIG1lYW5zIHdlIGNhbiBjb250aW51ZSBwcm9jZXNzaW5nXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBHaXZlIG90aGVyIGV2ZW50cyBhIGNoYW5jZSB0byBydW5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9tc2dUaW1lciA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFV0aWwuRGVidWcoXCJNb3JlIGRhdGEgdG8gcHJvY2VzcywgY3JlYXRpbmcgdGltZXJcIik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fbXNnVGltZXIgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fbXNnVGltZXIgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9oYW5kbGVfbWVzc2FnZSgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0uYmluZCh0aGlzKSwgMCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFV0aWwuRGVidWcoXCJNb3JlIGRhdGEgdG8gcHJvY2VzcywgZXhpc3RpbmcgdGltZXJcIik7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5faW5pdF9tc2coKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2hhbmRsZUtleVByZXNzOiBmdW5jdGlvbiAoa2V5ZXZlbnQpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl92aWV3X29ubHkpIHsgcmV0dXJuOyB9IC8vIFZpZXcgb25seSwgc2tpcCBrZXlib2FyZCwgZXZlbnRzXG5cbiAgICAgICAgICAgIHZhciBkb3duID0gKGtleWV2ZW50LnR5cGUgPT0gJ2tleWRvd24nKTtcbiAgICAgICAgICAgIGlmICh0aGlzLl9xZW11RXh0S2V5RXZlbnRTdXBwb3J0ZWQpIHtcbiAgICAgICAgICAgICAgICB2YXIgc2NhbmNvZGUgPSBYdFNjYW5jb2RlW2tleWV2ZW50LmNvZGVdO1xuICAgICAgICAgICAgICAgIGlmIChzY2FuY29kZSkge1xuICAgICAgICAgICAgICAgICAgICB2YXIga2V5c3ltID0ga2V5ZXZlbnQua2V5c3ltO1xuICAgICAgICAgICAgICAgICAgICBSRkIubWVzc2FnZXMuUUVNVUV4dGVuZGVkS2V5RXZlbnQodGhpcy5fc29jaywga2V5c3ltLCBkb3duLCBzY2FuY29kZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgVXRpbC5FcnJvcignVW5hYmxlIHRvIGZpbmQgYSB4dCBzY2FuY29kZSBmb3IgY29kZSA9ICcgKyBrZXlldmVudC5jb2RlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGtleXN5bSA9IGtleWV2ZW50LmtleXN5bS5rZXlzeW07XG4gICAgICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmtleUV2ZW50KHRoaXMuX3NvY2ssIGtleXN5bSwgZG93bik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2hhbmRsZU1vdXNlQnV0dG9uOiBmdW5jdGlvbiAoeCwgeSwgZG93biwgYm1hc2spIHtcbiAgICAgICAgICAgIGlmIChkb3duKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fbW91c2VfYnV0dG9uTWFzayB8PSBibWFzaztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fbW91c2VfYnV0dG9uTWFzayBePSBibWFzaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX3ZpZXdwb3J0RHJhZykge1xuICAgICAgICAgICAgICAgIGlmIChkb3duICYmICF0aGlzLl92aWV3cG9ydERyYWdnaW5nKSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3ZpZXdwb3J0RHJhZ2dpbmcgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl92aWV3cG9ydERyYWdQb3MgPSB7J3gnOiB4LCAneSc6IHl9O1xuXG4gICAgICAgICAgICAgICAgICAgIC8vIFNraXAgc2VuZGluZyBtb3VzZSBldmVudHNcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3ZpZXdwb3J0RHJhZ2dpbmcgPSBmYWxzZTtcblxuICAgICAgICAgICAgICAgICAgICAvLyBJZiB0aGUgdmlld3BvcnQgZGlkbid0IGFjdHVhbGx5IG1vdmUsIHRoZW4gdHJlYXQgYXMgYSBtb3VzZSBjbGljayBldmVudFxuICAgICAgICAgICAgICAgICAgICAvLyBTZW5kIHRoZSBidXR0b24gZG93biBldmVudCBoZXJlLCBhcyB0aGUgYnV0dG9uIHVwIGV2ZW50IGlzIHNlbnQgYXQgdGhlIGVuZCBvZiB0aGlzIGZ1bmN0aW9uXG4gICAgICAgICAgICAgICAgICAgIGlmICghdGhpcy5fdmlld3BvcnRIYXNNb3ZlZCAmJiAhdGhpcy5fdmlld19vbmx5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBSRkIubWVzc2FnZXMucG9pbnRlckV2ZW50KHRoaXMuX3NvY2ssIHRoaXMuX2Rpc3BsYXkuYWJzWCh4KSwgdGhpcy5fZGlzcGxheS5hYnNZKHkpLCBibWFzayk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdmlld3BvcnRIYXNNb3ZlZCA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX3ZpZXdfb25seSkgeyByZXR1cm47IH0gLy8gVmlldyBvbmx5LCBza2lwIG1vdXNlIGV2ZW50c1xuXG4gICAgICAgICAgICBpZiAodGhpcy5fcmZiX3N0YXRlICE9PSBcIm5vcm1hbFwiKSB7IHJldHVybjsgfVxuICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLnBvaW50ZXJFdmVudCh0aGlzLl9zb2NrLCB0aGlzLl9kaXNwbGF5LmFic1goeCksIHRoaXMuX2Rpc3BsYXkuYWJzWSh5KSwgdGhpcy5fbW91c2VfYnV0dG9uTWFzayk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2hhbmRsZU1vdXNlTW92ZTogZnVuY3Rpb24gKHgsIHkpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl92aWV3cG9ydERyYWdnaW5nKSB7XG4gICAgICAgICAgICAgICAgdmFyIGRlbHRhWCA9IHRoaXMuX3ZpZXdwb3J0RHJhZ1Bvcy54IC0geDtcbiAgICAgICAgICAgICAgICB2YXIgZGVsdGFZID0gdGhpcy5fdmlld3BvcnREcmFnUG9zLnkgLSB5O1xuXG4gICAgICAgICAgICAgICAgLy8gVGhlIGdvYWwgaXMgdG8gdHJpZ2dlciBvbiBhIGNlcnRhaW4gcGh5c2ljYWwgd2lkdGgsIHRoZVxuICAgICAgICAgICAgICAgIC8vIGRldmljZVBpeGVsUmF0aW8gYnJpbmdzIHVzIGEgYml0IGNsb3NlciBidXQgaXMgbm90IG9wdGltYWwuXG4gICAgICAgICAgICAgICAgdmFyIGRyYWdUaHJlc2hvbGQgPSAxMCAqICh3aW5kb3cuZGV2aWNlUGl4ZWxSYXRpbyB8fCAxKTtcblxuICAgICAgICAgICAgICAgIGlmICh0aGlzLl92aWV3cG9ydEhhc01vdmVkIHx8IChNYXRoLmFicyhkZWx0YVgpID4gZHJhZ1RocmVzaG9sZCB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBNYXRoLmFicyhkZWx0YVkpID4gZHJhZ1RocmVzaG9sZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdmlld3BvcnRIYXNNb3ZlZCA9IHRydWU7XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdmlld3BvcnREcmFnUG9zID0geyd4JzogeCwgJ3knOiB5fTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZGlzcGxheS52aWV3cG9ydENoYW5nZVBvcyhkZWx0YVgsIGRlbHRhWSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy8gU2tpcCBzZW5kaW5nIG1vdXNlIGV2ZW50c1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX3ZpZXdfb25seSkgeyByZXR1cm47IH0gLy8gVmlldyBvbmx5LCBza2lwIG1vdXNlIGV2ZW50c1xuXG4gICAgICAgICAgICBpZiAodGhpcy5fcmZiX3N0YXRlICE9PSBcIm5vcm1hbFwiKSB7IHJldHVybjsgfVxuICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLnBvaW50ZXJFdmVudCh0aGlzLl9zb2NrLCB0aGlzLl9kaXNwbGF5LmFic1goeCksIHRoaXMuX2Rpc3BsYXkuYWJzWSh5KSwgdGhpcy5fbW91c2VfYnV0dG9uTWFzayk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gTWVzc2FnZSBIYW5kbGVyc1xuXG4gICAgICAgIF9uZWdvdGlhdGVfcHJvdG9jb2xfdmVyc2lvbjogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclFsZW4oKSA8IDEyKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJJbmNvbXBsZXRlIHByb3RvY29sIHZlcnNpb25cIik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHZhciBzdmVyc2lvbiA9IHRoaXMuX3NvY2suclFzaGlmdFN0cigxMikuc3Vic3RyKDQsIDcpO1xuICAgICAgICAgICAgVXRpbC5JbmZvKFwiU2VydmVyIFByb3RvY29sVmVyc2lvbjogXCIgKyBzdmVyc2lvbik7XG4gICAgICAgICAgICB2YXIgaXNfcmVwZWF0ZXIgPSAwO1xuICAgICAgICAgICAgc3dpdGNoIChzdmVyc2lvbikge1xuICAgICAgICAgICAgICAgIGNhc2UgXCIwMDAuMDAwXCI6ICAvLyBVbHRyYVZOQyByZXBlYXRlclxuICAgICAgICAgICAgICAgICAgICBpc19yZXBlYXRlciA9IDE7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgXCIwMDMuMDAzXCI6XG4gICAgICAgICAgICAgICAgY2FzZSBcIjAwMy4wMDZcIjogIC8vIFVsdHJhVk5DXG4gICAgICAgICAgICAgICAgY2FzZSBcIjAwMy44ODlcIjogIC8vIEFwcGxlIFJlbW90ZSBEZXNrdG9wXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3JmYl92ZXJzaW9uID0gMy4zO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIFwiMDAzLjAwN1wiOlxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9yZmJfdmVyc2lvbiA9IDMuNztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSBcIjAwMy4wMDhcIjpcbiAgICAgICAgICAgICAgICBjYXNlIFwiMDA0LjAwMFwiOiAgLy8gSW50ZWwgQU1UIEtWTVxuICAgICAgICAgICAgICAgIGNhc2UgXCIwMDQuMDAxXCI6ICAvLyBSZWFsVk5DIDQuNlxuICAgICAgICAgICAgICAgIGNhc2UgXCIwMDUuMDAwXCI6ICAvLyBSZWFsVk5DIDUuM1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9yZmJfdmVyc2lvbiA9IDMuODtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJJbnZhbGlkIHNlcnZlciB2ZXJzaW9uIFwiICsgc3ZlcnNpb24pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaXNfcmVwZWF0ZXIpIHtcbiAgICAgICAgICAgICAgICB2YXIgcmVwZWF0ZXJJRCA9IHRoaXMuX3JlcGVhdGVySUQ7XG4gICAgICAgICAgICAgICAgd2hpbGUgKHJlcGVhdGVySUQubGVuZ3RoIDwgMjUwKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlcGVhdGVySUQgKz0gXCJcXDBcIjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5zZW5kX3N0cmluZyhyZXBlYXRlcklEKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX3JmYl92ZXJzaW9uID4gdGhpcy5fcmZiX21heF92ZXJzaW9uKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fcmZiX3ZlcnNpb24gPSB0aGlzLl9yZmJfbWF4X3ZlcnNpb247XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHZhciBjdmVyc2lvbiA9IFwiMDBcIiArIHBhcnNlSW50KHRoaXMuX3JmYl92ZXJzaW9uLCAxMCkgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgXCIuMDBcIiArICgodGhpcy5fcmZiX3ZlcnNpb24gKiAxMCkgJSAxMCk7XG4gICAgICAgICAgICB0aGlzLl9zb2NrLnNlbmRfc3RyaW5nKFwiUkZCIFwiICsgY3ZlcnNpb24gKyBcIlxcblwiKTtcbiAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdTZWN1cml0eScsICdTZW50IFByb3RvY29sVmVyc2lvbjogJyArIGN2ZXJzaW9uKTtcbiAgICAgICAgfSxcblxuICAgICAgICBfbmVnb3RpYXRlX3NlY3VyaXR5OiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fcmZiX3ZlcnNpb24gPj0gMy43KSB7XG4gICAgICAgICAgICAgICAgLy8gU2VydmVyIHNlbmRzIHN1cHBvcnRlZCBsaXN0LCBjbGllbnQgZGVjaWRlc1xuICAgICAgICAgICAgICAgIHZhciBudW1fdHlwZXMgPSB0aGlzLl9zb2NrLnJRc2hpZnQ4KCk7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwic2VjdXJpdHkgdHlwZVwiLCBudW1fdHlwZXMsIDEpKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgICAgICAgICAgICAgaWYgKG51bV90eXBlcyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICB2YXIgc3RybGVuID0gdGhpcy5fc29jay5yUXNoaWZ0MzIoKTtcbiAgICAgICAgICAgICAgICAgICAgdmFyIHJlYXNvbiA9IHRoaXMuX3NvY2suclFzaGlmdFN0cihzdHJsZW4pO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChcIlNlY3VyaXR5IGZhaWx1cmU6IFwiICsgcmVhc29uKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB0aGlzLl9yZmJfYXV0aF9zY2hlbWUgPSAwO1xuICAgICAgICAgICAgICAgIHZhciB0eXBlcyA9IHRoaXMuX3NvY2suclFzaGlmdEJ5dGVzKG51bV90eXBlcyk7XG4gICAgICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIlNlcnZlciBzZWN1cml0eSB0eXBlczogXCIgKyB0eXBlcyk7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0eXBlcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgICAgICAgICBpZiAodHlwZXNbaV0gPiB0aGlzLl9yZmJfYXV0aF9zY2hlbWUgJiYgKHR5cGVzW2ldIDw9IDE2IHx8IHR5cGVzW2ldID09IDIyKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcmZiX2F1dGhfc2NoZW1lID0gdHlwZXNbaV07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fcmZiX2F1dGhfc2NoZW1lID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiVW5zdXBwb3J0ZWQgc2VjdXJpdHkgdHlwZXM6IFwiICsgdHlwZXMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suc2VuZChbdGhpcy5fcmZiX2F1dGhfc2NoZW1lXSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIFNlcnZlciBkZWNpZGVzXG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwic2VjdXJpdHkgc2NoZW1lXCIsIDQpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgICAgIHRoaXMuX3JmYl9hdXRoX3NjaGVtZSA9IHRoaXMuX3NvY2suclFzaGlmdDMyKCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdBdXRoZW50aWNhdGlvbicsICdBdXRoZW50aWNhdGluZyB1c2luZyBzY2hlbWU6ICcgKyB0aGlzLl9yZmJfYXV0aF9zY2hlbWUpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2luaXRfbXNnKCk7IC8vIGp1bXAgdG8gYXV0aGVudGljYXRpb25cbiAgICAgICAgfSxcblxuICAgICAgICAvLyBhdXRoZW50aWNhdGlvblxuICAgICAgICBfbmVnb3RpYXRlX3h2cF9hdXRoOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB2YXIgeHZwX3NlcCA9IHRoaXMuX3h2cF9wYXNzd29yZF9zZXA7XG4gICAgICAgICAgICB2YXIgeHZwX2F1dGggPSB0aGlzLl9yZmJfcGFzc3dvcmQuc3BsaXQoeHZwX3NlcCk7XG4gICAgICAgICAgICBpZiAoeHZwX2F1dGgubGVuZ3RoIDwgMykge1xuICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdwYXNzd29yZCcsICdYVlAgY3JlZGVudGlhbHMgcmVxdWlyZWQgKHVzZXInICsgeHZwX3NlcCArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ3RhcmdldCcgKyB4dnBfc2VwICsgJ3Bhc3N3b3JkKSAtLSBnb3Qgb25seSAnICsgdGhpcy5fcmZiX3Bhc3N3b3JkKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9vblBhc3N3b3JkUmVxdWlyZWQodGhpcyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YXIgeHZwX2F1dGhfc3RyID0gU3RyaW5nLmZyb21DaGFyQ29kZSh4dnBfYXV0aFswXS5sZW5ndGgpICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBTdHJpbmcuZnJvbUNoYXJDb2RlKHh2cF9hdXRoWzFdLmxlbmd0aCkgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHh2cF9hdXRoWzBdICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB4dnBfYXV0aFsxXTtcbiAgICAgICAgICAgIHRoaXMuX3NvY2suc2VuZF9zdHJpbmcoeHZwX2F1dGhfc3RyKTtcbiAgICAgICAgICAgIHRoaXMuX3JmYl9wYXNzd29yZCA9IHh2cF9hdXRoLnNsaWNlKDIpLmpvaW4oeHZwX3NlcCk7XG4gICAgICAgICAgICB0aGlzLl9yZmJfYXV0aF9zY2hlbWUgPSAyO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX25lZ290aWF0ZV9hdXRoZW50aWNhdGlvbigpO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9uZWdvdGlhdGVfc3RkX3ZuY19hdXRoOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fcmZiX3Bhc3N3b3JkLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICAgIC8vIE5vdGlmeSB2aWEgYm90aCBjYWxsYmFja3Mgc2luY2UgaXQncyBraW5kIG9mXG4gICAgICAgICAgICAgICAgLy8gYW4gUkZCIHN0YXRlIGNoYW5nZSBhbmQgYSBVSSBpbnRlcmZhY2UgaXNzdWVcbiAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgncGFzc3dvcmQnLCBcIlBhc3N3b3JkIFJlcXVpcmVkXCIpO1xuICAgICAgICAgICAgICAgIHRoaXMuX29uUGFzc3dvcmRSZXF1aXJlZCh0aGlzKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcImF1dGggY2hhbGxlbmdlXCIsIDE2KSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgLy8gVE9ETyhkaXJlY3R4bWFuMTIpOiBtYWtlIGdlbkRFUyBub3QgcmVxdWlyZSBhbiBBcnJheVxuICAgICAgICAgICAgdmFyIGNoYWxsZW5nZSA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKHRoaXMuX3NvY2suclFzaGlmdEJ5dGVzKDE2KSk7XG4gICAgICAgICAgICB2YXIgcmVzcG9uc2UgPSBSRkIuZ2VuREVTKHRoaXMuX3JmYl9wYXNzd29yZCwgY2hhbGxlbmdlKTtcbiAgICAgICAgICAgIHRoaXMuX3NvY2suc2VuZChyZXNwb25zZSk7XG4gICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZShcIlNlY3VyaXR5UmVzdWx0XCIpO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX25lZ290aWF0ZV90aWdodF90dW5uZWxzOiBmdW5jdGlvbiAobnVtVHVubmVscykge1xuICAgICAgICAgICAgdmFyIGNsaWVudFN1cHBvcnRlZFR1bm5lbFR5cGVzID0ge1xuICAgICAgICAgICAgICAgIDA6IHsgdmVuZG9yOiAnVEdIVCcsIHNpZ25hdHVyZTogJ05PVFVOTkVMJyB9XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgdmFyIHNlcnZlclN1cHBvcnRlZFR1bm5lbFR5cGVzID0ge307XG4gICAgICAgICAgICAvLyByZWNlaXZlIHR1bm5lbCBjYXBhYmlsaXRpZXNcbiAgICAgICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbnVtVHVubmVsczsgaSsrKSB7XG4gICAgICAgICAgICAgICAgdmFyIGNhcF9jb2RlID0gdGhpcy5fc29jay5yUXNoaWZ0MzIoKTtcbiAgICAgICAgICAgICAgICB2YXIgY2FwX3ZlbmRvciA9IHRoaXMuX3NvY2suclFzaGlmdFN0cig0KTtcbiAgICAgICAgICAgICAgICB2YXIgY2FwX3NpZ25hdHVyZSA9IHRoaXMuX3NvY2suclFzaGlmdFN0cig4KTtcbiAgICAgICAgICAgICAgICBzZXJ2ZXJTdXBwb3J0ZWRUdW5uZWxUeXBlc1tjYXBfY29kZV0gPSB7IHZlbmRvcjogY2FwX3ZlbmRvciwgc2lnbmF0dXJlOiBjYXBfc2lnbmF0dXJlIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIGNob29zZSB0aGUgbm90dW5uZWwgdHlwZVxuICAgICAgICAgICAgaWYgKHNlcnZlclN1cHBvcnRlZFR1bm5lbFR5cGVzWzBdKSB7XG4gICAgICAgICAgICAgICAgaWYgKHNlcnZlclN1cHBvcnRlZFR1bm5lbFR5cGVzWzBdLnZlbmRvciAhPSBjbGllbnRTdXBwb3J0ZWRUdW5uZWxUeXBlc1swXS52ZW5kb3IgfHxcbiAgICAgICAgICAgICAgICAgICAgc2VydmVyU3VwcG9ydGVkVHVubmVsVHlwZXNbMF0uc2lnbmF0dXJlICE9IGNsaWVudFN1cHBvcnRlZFR1bm5lbFR5cGVzWzBdLnNpZ25hdHVyZSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChcIkNsaWVudCdzIHR1bm5lbCB0eXBlIGhhZCB0aGUgaW5jb3JyZWN0IHZlbmRvciBvciBzaWduYXR1cmVcIik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suc2VuZChbMCwgMCwgMCwgMF0pOyAgLy8gdXNlIE5PVFVOTkVMXG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlOyAvLyB3YWl0IHVudGlsIHdlIHJlY2VpdmUgdGhlIHN1YiBhdXRoIGNvdW50IHRvIGNvbnRpbnVlXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiU2VydmVyIHdhbnRlZCB0dW5uZWxzLCBidXQgZG9lc24ndCBzdXBwb3J0IHRoZSBub3R1bm5lbCB0eXBlXCIpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIF9uZWdvdGlhdGVfdGlnaHRfYXV0aDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKCF0aGlzLl9yZmJfdGlnaHR2bmMpIHsgIC8vIGZpcnN0IHBhc3MsIGRvIHRoZSB0dW5uZWwgbmVnb3RpYXRpb25cbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJudW0gdHVubmVsc1wiLCA0KSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgICAgICB2YXIgbnVtVHVubmVscyA9IHRoaXMuX3NvY2suclFzaGlmdDMyKCk7XG4gICAgICAgICAgICAgICAgaWYgKG51bVR1bm5lbHMgPiAwICYmIHRoaXMuX3NvY2suclF3YWl0KFwidHVubmVsIGNhcGFiaWxpdGllc1wiLCAxNiAqIG51bVR1bm5lbHMsIDQpKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgICAgICAgICAgICAgdGhpcy5fcmZiX3RpZ2h0dm5jID0gdHJ1ZTtcblxuICAgICAgICAgICAgICAgIGlmIChudW1UdW5uZWxzID4gMCkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9uZWdvdGlhdGVfdGlnaHRfdHVubmVscyhudW1UdW5uZWxzKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlOyAgLy8gd2FpdCB1bnRpbCB3ZSByZWNlaXZlIHRoZSBzdWIgYXV0aCB0byBjb250aW51ZVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gc2Vjb25kIHBhc3MsIGRvIHRoZSBzdWItYXV0aCBuZWdvdGlhdGlvblxuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwic3ViIGF1dGggY291bnRcIiwgNCkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICB2YXIgc3ViQXV0aENvdW50ID0gdGhpcy5fc29jay5yUXNoaWZ0MzIoKTtcbiAgICAgICAgICAgIGlmIChzdWJBdXRoQ291bnQgPT09IDApIHsgIC8vIGVtcHR5IHN1Yi1hdXRoIGxpc3QgcmVjZWl2ZWQgbWVhbnMgJ25vIGF1dGgnIHN1YnR5cGUgc2VsZWN0ZWRcbiAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgnU2VjdXJpdHlSZXN1bHQnKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwic3ViIGF1dGggY2FwYWJpbGl0aWVzXCIsIDE2ICogc3ViQXV0aENvdW50LCA0KSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgdmFyIGNsaWVudFN1cHBvcnRlZFR5cGVzID0ge1xuICAgICAgICAgICAgICAgICdTVERWTk9BVVRIX18nOiAxLFxuICAgICAgICAgICAgICAgICdTVERWVk5DQVVUSF8nOiAyXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICB2YXIgc2VydmVyU3VwcG9ydGVkVHlwZXMgPSBbXTtcblxuICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzdWJBdXRoQ291bnQ7IGkrKykge1xuICAgICAgICAgICAgICAgIHZhciBjYXBOdW0gPSB0aGlzLl9zb2NrLnJRc2hpZnQzMigpO1xuICAgICAgICAgICAgICAgIHZhciBjYXBhYmlsaXRpZXMgPSB0aGlzLl9zb2NrLnJRc2hpZnRTdHIoMTIpO1xuICAgICAgICAgICAgICAgIHNlcnZlclN1cHBvcnRlZFR5cGVzLnB1c2goY2FwYWJpbGl0aWVzKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZm9yICh2YXIgYXV0aFR5cGUgaW4gY2xpZW50U3VwcG9ydGVkVHlwZXMpIHtcbiAgICAgICAgICAgICAgICBpZiAoc2VydmVyU3VwcG9ydGVkVHlwZXMuaW5kZXhPZihhdXRoVHlwZSkgIT0gLTEpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5zZW5kKFswLCAwLCAwLCBjbGllbnRTdXBwb3J0ZWRUeXBlc1thdXRoVHlwZV1dKTtcblxuICAgICAgICAgICAgICAgICAgICBzd2l0Y2ggKGF1dGhUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYXNlICdTVERWTk9BVVRIX18nOiAgLy8gbm8gYXV0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdTZWN1cml0eVJlc3VsdCcpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnU1REVlZOQ0FVVEhfJzogLy8gVk5DIGF1dGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9yZmJfYXV0aF9zY2hlbWUgPSAyO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9pbml0X21zZygpO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChcIlVuc3VwcG9ydGVkIHRpbnkgYXV0aCBzY2hlbWU6IFwiICsgYXV0aFR5cGUpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChcIk5vIHN1cHBvcnRlZCBzdWItYXV0aCB0eXBlcyFcIik7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX25lZ290aWF0ZV9hdXRoZW50aWNhdGlvbjogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgc3dpdGNoICh0aGlzLl9yZmJfYXV0aF9zY2hlbWUpIHtcbiAgICAgICAgICAgICAgICBjYXNlIDA6ICAvLyBjb25uZWN0aW9uIGZhaWxlZFxuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJhdXRoIHJlYXNvblwiLCA0KSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgICAgICAgICAgdmFyIHN0cmxlbiA9IHRoaXMuX3NvY2suclFzaGlmdDMyKCk7XG4gICAgICAgICAgICAgICAgICAgIHZhciByZWFzb24gPSB0aGlzLl9zb2NrLnJRc2hpZnRTdHIoc3RybGVuKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJBdXRoIGZhaWx1cmU6IFwiICsgcmVhc29uKTtcblxuICAgICAgICAgICAgICAgIGNhc2UgMTogIC8vIG5vIGF1dGhcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3JmYl92ZXJzaW9uID49IDMuOCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ1NlY3VyaXR5UmVzdWx0Jyk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgnQ2xpZW50SW5pdGlhbGlzYXRpb24nLCBcIk5vIGF1dGggcmVxdWlyZWRcIik7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9pbml0X21zZygpO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAyMjogIC8vIFhWUCBhdXRoXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9uZWdvdGlhdGVfeHZwX2F1dGgoKTtcblxuICAgICAgICAgICAgICAgIGNhc2UgMjogIC8vIFZOQyBhdXRoZW50aWNhdGlvblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fbmVnb3RpYXRlX3N0ZF92bmNfYXV0aCgpO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAxNjogIC8vIFRpZ2h0Vk5DIFNlY3VyaXR5IFR5cGVcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX25lZ290aWF0ZV90aWdodF9hdXRoKCk7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChcIlVuc3VwcG9ydGVkIGF1dGggc2NoZW1lOiBcIiArIHRoaXMuX3JmYl9hdXRoX3NjaGVtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2hhbmRsZV9zZWN1cml0eV9yZXN1bHQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdCgnVk5DIGF1dGggcmVzcG9uc2UgJywgNCkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICBzd2l0Y2ggKHRoaXMuX3NvY2suclFzaGlmdDMyKCkpIHtcbiAgICAgICAgICAgICAgICBjYXNlIDA6ICAvLyBPS1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgnQ2xpZW50SW5pdGlhbGlzYXRpb24nLCAnQXV0aGVudGljYXRpb24gT0snKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2luaXRfbXNnKCk7XG4gICAgICAgICAgICAgICAgY2FzZSAxOiAgLy8gZmFpbGVkXG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9yZmJfdmVyc2lvbiA+PSAzLjgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHZhciBsZW5ndGggPSB0aGlzLl9zb2NrLnJRc2hpZnQzMigpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiU2VjdXJpdHlSZXN1bHQgcmVhc29uXCIsIGxlbmd0aCwgOCkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICAgICAgICAgICAgICB2YXIgcmVhc29uID0gdGhpcy5fc29jay5yUXNoaWZ0U3RyKGxlbmd0aCk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChyZWFzb24pO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJBdXRoZW50aWNhdGlvbiBmYWlsdXJlXCIpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgICAgICBjYXNlIDI6XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiVG9vIG1hbnkgYXV0aCBhdHRlbXB0c1wiKTtcbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChcIlVua25vd24gU2VjdXJpdHlSZXN1bHRcIik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgX25lZ290aWF0ZV9zZXJ2ZXJfaW5pdDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwic2VydmVyIGluaXRpYWxpemF0aW9uXCIsIDI0KSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgLyogU2NyZWVuIHNpemUgKi9cbiAgICAgICAgICAgIHRoaXMuX2ZiX3dpZHRoICA9IHRoaXMuX3NvY2suclFzaGlmdDE2KCk7XG4gICAgICAgICAgICB0aGlzLl9mYl9oZWlnaHQgPSB0aGlzLl9zb2NrLnJRc2hpZnQxNigpO1xuICAgICAgICAgICAgdGhpcy5fZGVzdEJ1ZmYgPSBuZXcgVWludDhBcnJheSh0aGlzLl9mYl93aWR0aCAqIHRoaXMuX2ZiX2hlaWdodCAqIDQpO1xuXG4gICAgICAgICAgICAvKiBQSVhFTF9GT1JNQVQgKi9cbiAgICAgICAgICAgIHZhciBicHAgICAgICAgICA9IHRoaXMuX3NvY2suclFzaGlmdDgoKTtcbiAgICAgICAgICAgIHZhciBkZXB0aCAgICAgICA9IHRoaXMuX3NvY2suclFzaGlmdDgoKTtcbiAgICAgICAgICAgIHZhciBiaWdfZW5kaWFuICA9IHRoaXMuX3NvY2suclFzaGlmdDgoKTtcbiAgICAgICAgICAgIHZhciB0cnVlX2NvbG9yICA9IHRoaXMuX3NvY2suclFzaGlmdDgoKTtcblxuICAgICAgICAgICAgdmFyIHJlZF9tYXggICAgID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgIHZhciBncmVlbl9tYXggICA9IHRoaXMuX3NvY2suclFzaGlmdDE2KCk7XG4gICAgICAgICAgICB2YXIgYmx1ZV9tYXggICAgPSB0aGlzLl9zb2NrLnJRc2hpZnQxNigpO1xuICAgICAgICAgICAgdmFyIHJlZF9zaGlmdCAgID0gdGhpcy5fc29jay5yUXNoaWZ0OCgpO1xuICAgICAgICAgICAgdmFyIGdyZWVuX3NoaWZ0ID0gdGhpcy5fc29jay5yUXNoaWZ0OCgpO1xuICAgICAgICAgICAgdmFyIGJsdWVfc2hpZnQgID0gdGhpcy5fc29jay5yUXNoaWZ0OCgpO1xuICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygzKTsgIC8vIHBhZGRpbmdcblxuICAgICAgICAgICAgLy8gTkIoZGlyZWN0eG1hbjEyKTogd2UgZG9uJ3Qgd2FudCB0byBjYWxsIGFueSBjYWxsYmFja3Mgb3IgcHJpbnQgbWVzc2FnZXMgdW50aWxcbiAgICAgICAgICAgIC8vICAgICAgICAgICAgICAgICAgICphZnRlciogd2UncmUgcGFzdCB0aGUgcG9pbnQgd2hlcmUgd2UgY291bGQgYmFja3RyYWNrXG5cbiAgICAgICAgICAgIC8qIENvbm5lY3Rpb24gbmFtZS90aXRsZSAqL1xuICAgICAgICAgICAgdmFyIG5hbWVfbGVuZ3RoID0gdGhpcy5fc29jay5yUXNoaWZ0MzIoKTtcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdCgnc2VydmVyIGluaXQgbmFtZScsIG5hbWVfbGVuZ3RoLCAyNCkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICB0aGlzLl9mYl9uYW1lID0gVXRpbC5kZWNvZGVVVEY4KHRoaXMuX3NvY2suclFzaGlmdFN0cihuYW1lX2xlbmd0aCkpO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5fcmZiX3RpZ2h0dm5jKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KCdUaWdodFZOQyBleHRlbmRlZCBzZXJ2ZXIgaW5pdCBoZWFkZXInLCA4LCAyNCArIG5hbWVfbGVuZ3RoKSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgICAgICAvLyBJbiBUaWdodFZOQyBtb2RlLCBTZXJ2ZXJJbml0IG1lc3NhZ2UgaXMgZXh0ZW5kZWRcbiAgICAgICAgICAgICAgICB2YXIgbnVtU2VydmVyTWVzc2FnZXMgPSB0aGlzLl9zb2NrLnJRc2hpZnQxNigpO1xuICAgICAgICAgICAgICAgIHZhciBudW1DbGllbnRNZXNzYWdlcyA9IHRoaXMuX3NvY2suclFzaGlmdDE2KCk7XG4gICAgICAgICAgICAgICAgdmFyIG51bUVuY29kaW5ncyA9IHRoaXMuX3NvY2suclFzaGlmdDE2KCk7XG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygyKTsgIC8vIHBhZGRpbmdcblxuICAgICAgICAgICAgICAgIHZhciB0b3RhbE1lc3NhZ2VzTGVuZ3RoID0gKG51bVNlcnZlck1lc3NhZ2VzICsgbnVtQ2xpZW50TWVzc2FnZXMgKyBudW1FbmNvZGluZ3MpICogMTY7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KCdUaWdodFZOQyBleHRlbmRlZCBzZXJ2ZXIgaW5pdCBoZWFkZXInLCB0b3RhbE1lc3NhZ2VzTGVuZ3RoLCAzMiArIG5hbWVfbGVuZ3RoKSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgICAgIC8vIHdlIGRvbid0IGFjdHVhbGx5IGRvIGFueXRoaW5nIHdpdGggdGhlIGNhcGFiaWxpdHkgaW5mb3JtYXRpb24gdGhhdCBUSUdIVCBzZW5kcyxcbiAgICAgICAgICAgICAgICAvLyBzbyB3ZSBqdXN0IHNraXAgdGhlIGFsbCBvZiB0aGlzLlxuXG4gICAgICAgICAgICAgICAgLy8gVElHSFQgc2VydmVyIG1lc3NhZ2UgY2FwYWJpbGl0aWVzXG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygxNiAqIG51bVNlcnZlck1lc3NhZ2VzKTtcblxuICAgICAgICAgICAgICAgIC8vIFRJR0hUIGNsaWVudCBtZXNzYWdlIGNhcGFiaWxpdGllc1xuICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwQnl0ZXMoMTYgKiBudW1DbGllbnRNZXNzYWdlcyk7XG5cbiAgICAgICAgICAgICAgICAvLyBUSUdIVCBlbmNvZGluZyBjYXBhYmlsaXRpZXNcbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKDE2ICogbnVtRW5jb2RpbmdzKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gTkIoZGlyZWN0eG1hbjEyKTogdGhlc2UgYXJlIGRvd24gaGVyZSBzbyB0aGF0IHdlIGRvbid0IHJ1biB0aGVtIG11bHRpcGxlIHRpbWVzXG4gICAgICAgICAgICAvLyAgICAgICAgICAgICAgICAgICBpZiB3ZSBiYWNrdHJhY2tcbiAgICAgICAgICAgIFV0aWwuSW5mbyhcIlNjcmVlbjogXCIgKyB0aGlzLl9mYl93aWR0aCArIFwieFwiICsgdGhpcy5fZmJfaGVpZ2h0ICtcbiAgICAgICAgICAgICAgICAgICAgICBcIiwgYnBwOiBcIiArIGJwcCArIFwiLCBkZXB0aDogXCIgKyBkZXB0aCArXG4gICAgICAgICAgICAgICAgICAgICAgXCIsIGJpZ19lbmRpYW46IFwiICsgYmlnX2VuZGlhbiArXG4gICAgICAgICAgICAgICAgICAgICAgXCIsIHRydWVfY29sb3I6IFwiICsgdHJ1ZV9jb2xvciArXG4gICAgICAgICAgICAgICAgICAgICAgXCIsIHJlZF9tYXg6IFwiICsgcmVkX21heCArXG4gICAgICAgICAgICAgICAgICAgICAgXCIsIGdyZWVuX21heDogXCIgKyBncmVlbl9tYXggK1xuICAgICAgICAgICAgICAgICAgICAgIFwiLCBibHVlX21heDogXCIgKyBibHVlX21heCArXG4gICAgICAgICAgICAgICAgICAgICAgXCIsIHJlZF9zaGlmdDogXCIgKyByZWRfc2hpZnQgK1xuICAgICAgICAgICAgICAgICAgICAgIFwiLCBncmVlbl9zaGlmdDogXCIgKyBncmVlbl9zaGlmdCArXG4gICAgICAgICAgICAgICAgICAgICAgXCIsIGJsdWVfc2hpZnQ6IFwiICsgYmx1ZV9zaGlmdCk7XG5cbiAgICAgICAgICAgIGlmIChiaWdfZW5kaWFuICE9PSAwKSB7XG4gICAgICAgICAgICAgICAgVXRpbC5XYXJuKFwiU2VydmVyIG5hdGl2ZSBlbmRpYW4gaXMgbm90IGxpdHRsZSBlbmRpYW5cIik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChyZWRfc2hpZnQgIT09IDE2KSB7XG4gICAgICAgICAgICAgICAgVXRpbC5XYXJuKFwiU2VydmVyIG5hdGl2ZSByZWQtc2hpZnQgaXMgbm90IDE2XCIpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoYmx1ZV9zaGlmdCAhPT0gMCkge1xuICAgICAgICAgICAgICAgIFV0aWwuV2FybihcIlNlcnZlciBuYXRpdmUgYmx1ZS1zaGlmdCBpcyBub3QgMFwiKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gd2UncmUgcGFzdCB0aGUgcG9pbnQgd2hlcmUgd2UgY291bGQgYmFja3RyYWNrLCBzbyBpdCdzIHNhZmUgdG8gY2FsbCB0aGlzXG4gICAgICAgICAgICB0aGlzLl9vbkRlc2t0b3BOYW1lKHRoaXMsIHRoaXMuX2ZiX25hbWUpO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5fdHJ1ZV9jb2xvciAmJiB0aGlzLl9mYl9uYW1lID09PSBcIkludGVsKHIpIEFNVCBLVk1cIikge1xuICAgICAgICAgICAgICAgIFV0aWwuV2FybihcIkludGVsIEFNVCBLVk0gb25seSBzdXBwb3J0cyA4LzE2IGJpdCBkZXB0aHMuICBEaXNhYmxpbmcgdHJ1ZSBjb2xvclwiKTtcbiAgICAgICAgICAgICAgICB0aGlzLl90cnVlX2NvbG9yID0gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuc2V0X3RydWVfY29sb3IodGhpcy5fdHJ1ZV9jb2xvcik7XG4gICAgICAgICAgICB0aGlzLl9kaXNwbGF5LnJlc2l6ZSh0aGlzLl9mYl93aWR0aCwgdGhpcy5fZmJfaGVpZ2h0KTtcbiAgICAgICAgICAgIHRoaXMuX29uRkJSZXNpemUodGhpcywgdGhpcy5fZmJfd2lkdGgsIHRoaXMuX2ZiX2hlaWdodCk7XG4gICAgICAgICAgICB0aGlzLl9rZXlib2FyZC5ncmFiKCk7XG4gICAgICAgICAgICB0aGlzLl9tb3VzZS5ncmFiKCk7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl90cnVlX2NvbG9yKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fZmJfQnBwID0gNDtcbiAgICAgICAgICAgICAgICB0aGlzLl9mYl9kZXB0aCA9IDM7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX2ZiX0JwcCA9IDE7XG4gICAgICAgICAgICAgICAgdGhpcy5fZmJfZGVwdGggPSAxO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBSRkIubWVzc2FnZXMucGl4ZWxGb3JtYXQodGhpcy5fc29jaywgdGhpcy5fZmJfQnBwLCB0aGlzLl9mYl9kZXB0aCwgdGhpcy5fdHJ1ZV9jb2xvcik7XG4gICAgICAgICAgICBSRkIubWVzc2FnZXMuY2xpZW50RW5jb2RpbmdzKHRoaXMuX3NvY2ssIHRoaXMuX2VuY29kaW5ncywgdGhpcy5fbG9jYWxfY3Vyc29yLCB0aGlzLl90cnVlX2NvbG9yKTtcbiAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5mYlVwZGF0ZVJlcXVlc3RzKHRoaXMuX3NvY2ssIGZhbHNlLCB0aGlzLl9kaXNwbGF5LmdldENsZWFuRGlydHlSZXNldCgpLCB0aGlzLl9mYl93aWR0aCwgdGhpcy5fZmJfaGVpZ2h0KTtcblxuICAgICAgICAgICAgdGhpcy5fdGltaW5nLmZidV9ydF9zdGFydCA9IChuZXcgRGF0ZSgpKS5nZXRUaW1lKCk7XG4gICAgICAgICAgICB0aGlzLl90aW1pbmcucGl4ZWxzID0gMDtcblxuICAgICAgICAgICAgaWYgKHRoaXMuX2VuY3J5cHQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgnbm9ybWFsJywgJ0Nvbm5lY3RlZCAoZW5jcnlwdGVkKSB0bzogJyArIHRoaXMuX2ZiX25hbWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgnbm9ybWFsJywgJ0Nvbm5lY3RlZCAodW5lbmNyeXB0ZWQpIHRvOiAnICsgdGhpcy5fZmJfbmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBfaW5pdF9tc2c6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHN3aXRjaCAodGhpcy5fcmZiX3N0YXRlKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnUHJvdG9jb2xWZXJzaW9uJzpcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX25lZ290aWF0ZV9wcm90b2NvbF92ZXJzaW9uKCk7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdTZWN1cml0eSc6XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9uZWdvdGlhdGVfc2VjdXJpdHkoKTtcblxuICAgICAgICAgICAgICAgIGNhc2UgJ0F1dGhlbnRpY2F0aW9uJzpcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX25lZ290aWF0ZV9hdXRoZW50aWNhdGlvbigpO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnU2VjdXJpdHlSZXN1bHQnOlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5faGFuZGxlX3NlY3VyaXR5X3Jlc3VsdCgpO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnQ2xpZW50SW5pdGlhbGlzYXRpb24nOlxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnNlbmQoW3RoaXMuX3NoYXJlZCA/IDEgOiAwXSk7IC8vIENsaWVudEluaXRpYWxpc2F0aW9uXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdTZXJ2ZXJJbml0aWFsaXNhdGlvbicsIFwiQXV0aGVudGljYXRpb24gT0tcIik7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnU2VydmVySW5pdGlhbGlzYXRpb24nOlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fbmVnb3RpYXRlX3NlcnZlcl9pbml0KCk7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChcIlVua25vd24gc3RhdGU6IFwiICsgdGhpcy5fcmZiX3N0YXRlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBfaGFuZGxlX3NldF9jb2xvdXJfbWFwX21zZzogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIlNldENvbG9yTWFwRW50cmllc1wiKTtcbiAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwOCgpOyAgLy8gUGFkZGluZ1xuXG4gICAgICAgICAgICB2YXIgZmlyc3RfY29sb3VyID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgIHZhciBudW1fY29sb3VycyA9IHRoaXMuX3NvY2suclFzaGlmdDE2KCk7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoJ1NldENvbG9yTWFwRW50cmllcycsIG51bV9jb2xvdXJzICogNiwgNikpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgIGZvciAodmFyIGMgPSAwOyBjIDwgbnVtX2NvbG91cnM7IGMrKykge1xuICAgICAgICAgICAgICAgIHZhciByZWQgPSBwYXJzZUludCh0aGlzLl9zb2NrLnJRc2hpZnQxNigpIC8gMjU2LCAxMCk7XG4gICAgICAgICAgICAgICAgdmFyIGdyZWVuID0gcGFyc2VJbnQodGhpcy5fc29jay5yUXNoaWZ0MTYoKSAvIDI1NiwgMTApO1xuICAgICAgICAgICAgICAgIHZhciBibHVlID0gcGFyc2VJbnQodGhpcy5fc29jay5yUXNoaWZ0MTYoKSAvIDI1NiwgMTApO1xuICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuc2V0X2NvbG91ck1hcChbYmx1ZSwgZ3JlZW4sIHJlZF0sIGZpcnN0X2NvbG91ciArIGMpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcImNvbG91ck1hcDogXCIgKyB0aGlzLl9kaXNwbGF5LmdldF9jb2xvdXJNYXAoKSk7XG4gICAgICAgICAgICBVdGlsLkluZm8oXCJSZWdpc3RlcmVkIFwiICsgbnVtX2NvbG91cnMgKyBcIiBjb2xvdXJNYXAgZW50cmllc1wiKTtcblxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2hhbmRsZV9zZXJ2ZXJfY3V0X3RleHQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIFV0aWwuRGVidWcoXCJTZXJ2ZXJDdXRUZXh0XCIpO1xuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiU2VydmVyQ3V0VGV4dCBoZWFkZXJcIiwgNywgMSkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKDMpOyAgLy8gUGFkZGluZ1xuICAgICAgICAgICAgdmFyIGxlbmd0aCA9IHRoaXMuX3NvY2suclFzaGlmdDMyKCk7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJTZXJ2ZXJDdXRUZXh0XCIsIGxlbmd0aCwgOCkpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgIHZhciB0ZXh0ID0gdGhpcy5fc29jay5yUXNoaWZ0U3RyKGxlbmd0aCk7XG4gICAgICAgICAgICB0aGlzLl9vbkNsaXBib2FyZCh0aGlzLCB0ZXh0KTtcblxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2hhbmRsZV9zZXJ2ZXJfZmVuY2VfbXNnOiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlNlcnZlckZlbmNlIGhlYWRlclwiLCA4LCAxKSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwQnl0ZXMoMyk7IC8vIFBhZGRpbmdcbiAgICAgICAgICAgIHZhciBmbGFncyA9IHRoaXMuX3NvY2suclFzaGlmdDMyKCk7XG4gICAgICAgICAgICB2YXIgbGVuZ3RoID0gdGhpcy5fc29jay5yUXNoaWZ0OCgpO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJTZXJ2ZXJGZW5jZSBwYXlsb2FkXCIsIGxlbmd0aCwgOSkpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgIGlmIChsZW5ndGggPiA2NCkge1xuICAgICAgICAgICAgICAgIFV0aWwuV2FybihcIkJhZCBwYXlsb2FkIGxlbmd0aCAoXCIgKyBsZW5ndGggKyBcIikgaW4gZmVuY2UgcmVzcG9uc2VcIik7XG4gICAgICAgICAgICAgICAgbGVuZ3RoID0gNjQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHZhciBwYXlsb2FkID0gdGhpcy5fc29jay5yUXNoaWZ0U3RyKGxlbmd0aCk7XG5cbiAgICAgICAgICAgIHRoaXMuX3N1cHBvcnRzRmVuY2UgPSB0cnVlO1xuXG4gICAgICAgICAgICAvKlxuICAgICAgICAgICAgICogRmVuY2UgZmxhZ3NcbiAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgKiAgKDE8PDApICAtIEJsb2NrQmVmb3JlXG4gICAgICAgICAgICAgKiAgKDE8PDEpICAtIEJsb2NrQWZ0ZXJcbiAgICAgICAgICAgICAqICAoMTw8MikgIC0gU3luY05leHRcbiAgICAgICAgICAgICAqICAoMTw8MzEpIC0gUmVxdWVzdFxuICAgICAgICAgICAgICovXG5cbiAgICAgICAgICAgIGlmICghKGZsYWdzICYgKDE8PDMxKSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChcIlVuZXhwZWN0ZWQgZmVuY2UgcmVzcG9uc2VcIik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIEZpbHRlciBvdXQgdW5zdXBwb3J0ZWQgZmxhZ3NcbiAgICAgICAgICAgIC8vIEZJWE1FOiBzdXBwb3J0IHN5bmNOZXh0XG4gICAgICAgICAgICBmbGFncyAmPSAoMTw8MCkgfCAoMTw8MSk7XG5cbiAgICAgICAgICAgIC8vIEJsb2NrQmVmb3JlIGFuZCBCbG9ja0FmdGVyIGFyZSBhdXRvbWF0aWNhbGx5IGhhbmRsZWQgYnlcbiAgICAgICAgICAgIC8vIHRoZSBmYWN0IHRoYXQgd2UgcHJvY2VzcyBlYWNoIGluY29taW5nIG1lc3NhZ2VcbiAgICAgICAgICAgIC8vIHN5bmNocm9udW9zbHkuXG4gICAgICAgICAgICBSRkIubWVzc2FnZXMuY2xpZW50RmVuY2UodGhpcy5fc29jaywgZmxhZ3MsIHBheWxvYWQpO1xuXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBfaGFuZGxlX3h2cF9tc2c6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlhWUCB2ZXJzaW9uIGFuZCBtZXNzYWdlXCIsIDMsIDEpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXA4KCk7ICAvLyBQYWRkaW5nXG4gICAgICAgICAgICB2YXIgeHZwX3ZlciA9IHRoaXMuX3NvY2suclFzaGlmdDgoKTtcbiAgICAgICAgICAgIHZhciB4dnBfbXNnID0gdGhpcy5fc29jay5yUXNoaWZ0OCgpO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHh2cF9tc2cpIHtcbiAgICAgICAgICAgICAgICBjYXNlIDA6ICAvLyBYVlBfRkFJTFxuICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSh0aGlzLl9yZmJfc3RhdGUsIFwiT3BlcmF0aW9uIEZhaWxlZFwiKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSAxOiAgLy8gWFZQX0lOSVRcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcmZiX3h2cF92ZXIgPSB4dnBfdmVyO1xuICAgICAgICAgICAgICAgICAgICBVdGlsLkluZm8oXCJYVlAgZXh0ZW5zaW9ucyBlbmFibGVkICh2ZXJzaW9uIFwiICsgdGhpcy5fcmZiX3h2cF92ZXIgKyBcIilcIik7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX29uWHZwSW5pdCh0aGlzLl9yZmJfeHZwX3Zlcik7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZhaWwoXCJEaXNjb25uZWN0ZWQ6IGlsbGVnYWwgc2VydmVyIFhWUCBtZXNzYWdlIFwiICsgeHZwX21zZyk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBfbm9ybWFsX21zZzogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdmFyIG1zZ190eXBlO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5fRkJVLnJlY3RzID4gMCkge1xuICAgICAgICAgICAgICAgIG1zZ190eXBlID0gMDtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgbXNnX3R5cGUgPSB0aGlzLl9zb2NrLnJRc2hpZnQ4KCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHN3aXRjaCAobXNnX3R5cGUpIHtcbiAgICAgICAgICAgICAgICBjYXNlIDA6ICAvLyBGcmFtZWJ1ZmZlclVwZGF0ZVxuICAgICAgICAgICAgICAgICAgICB2YXIgcmV0ID0gdGhpcy5fZnJhbWVidWZmZXJVcGRhdGUoKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJldCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmZiVXBkYXRlUmVxdWVzdHModGhpcy5fc29jayxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2VuYWJsZWRDb250aW51b3VzVXBkYXRlcyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuZ2V0Q2xlYW5EaXJ0eVJlc2V0KCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9mYl93aWR0aCwgdGhpcy5fZmJfaGVpZ2h0KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmV0O1xuXG4gICAgICAgICAgICAgICAgY2FzZSAxOiAgLy8gU2V0Q29sb3JNYXBFbnRyaWVzXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9oYW5kbGVfc2V0X2NvbG91cl9tYXBfbXNnKCk7XG5cbiAgICAgICAgICAgICAgICBjYXNlIDI6ICAvLyBCZWxsXG4gICAgICAgICAgICAgICAgICAgIFV0aWwuRGVidWcoXCJCZWxsXCIpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9vbkJlbGwodGhpcyk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAzOiAgLy8gU2VydmVyQ3V0VGV4dFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5faGFuZGxlX3NlcnZlcl9jdXRfdGV4dCgpO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAxNTA6IC8vIEVuZE9mQ29udGludW91c1VwZGF0ZXNcbiAgICAgICAgICAgICAgICAgICAgdmFyIGZpcnN0ID0gISh0aGlzLl9zdXBwb3J0c0NvbnRpbnVvdXNVcGRhdGVzKTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc3VwcG9ydHNDb250aW51b3VzVXBkYXRlcyA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2VuYWJsZWRDb250aW51b3VzVXBkYXRlcyA9IGZhbHNlO1xuICAgICAgICAgICAgICAgICAgICBpZiAoZmlyc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2VuYWJsZWRDb250aW51b3VzVXBkYXRlcyA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVDb250aW51b3VzVXBkYXRlcygpO1xuICAgICAgICAgICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiRW5hYmxpbmcgY29udGludW91cyB1cGRhdGVzLlwiKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIEZJWE1FOiBXZSBuZWVkIHRvIHNlbmQgYSBmcmFtZWJ1ZmZlcnVwZGF0ZXJlcXVlc3QgaGVyZVxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gaWYgd2UgYWRkIHN1cHBvcnQgZm9yIHR1cm5pbmcgb2ZmIGNvbnRpbnVvdXMgdXBkYXRlc1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAyNDg6IC8vIFNlcnZlckZlbmNlXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9oYW5kbGVfc2VydmVyX2ZlbmNlX21zZygpO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAyNTA6ICAvLyBYVlBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2hhbmRsZV94dnBfbXNnKCk7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9mYWlsKFwiRGlzY29ubmVjdGVkOiBpbGxlZ2FsIHNlcnZlciBtZXNzYWdlIHR5cGUgXCIgKyBtc2dfdHlwZSk7XG4gICAgICAgICAgICAgICAgICAgIFV0aWwuRGVidWcoXCJzb2NrLnJRc2xpY2UoMCwgMzApOiBcIiArIHRoaXMuX3NvY2suclFzbGljZSgwLCAzMCkpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBfZnJhbWVidWZmZXJVcGRhdGU6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHZhciByZXQgPSB0cnVlO1xuICAgICAgICAgICAgdmFyIG5vdztcblxuICAgICAgICAgICAgaWYgKHRoaXMuX0ZCVS5yZWN0cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIkZCVSBoZWFkZXJcIiwgMywgMSkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXA4KCk7ICAvLyBQYWRkaW5nXG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLnJlY3RzID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgPSAwO1xuICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5jdXJfZmJ1ID0gMDtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fdGltaW5nLmZidV9ydF9zdGFydCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgbm93ID0gKG5ldyBEYXRlKCkpLmdldFRpbWUoKTtcbiAgICAgICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiRmlyc3QgRkJVIGxhdGVuY3k6IFwiICsgKG5vdyAtIHRoaXMuX3RpbWluZy5mYnVfcnRfc3RhcnQpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHdoaWxlICh0aGlzLl9GQlUucmVjdHMgPiAwKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3JmYl9zdGF0ZSAhPT0gXCJub3JtYWxcIikgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIkZCVVwiLCB0aGlzLl9GQlUuYnl0ZXMpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9GQlUuYnl0ZXMgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwicmVjdCBoZWFkZXJcIiwgMTIpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgICAgICAgICAvKiBOZXcgRnJhbWVidWZmZXJVcGRhdGUgKi9cblxuICAgICAgICAgICAgICAgICAgICB2YXIgaGRyID0gdGhpcy5fc29jay5yUXNoaWZ0Qnl0ZXMoMTIpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUueCAgICAgICAgPSAoaGRyWzBdIDw8IDgpICsgaGRyWzFdO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUueSAgICAgICAgPSAoaGRyWzJdIDw8IDgpICsgaGRyWzNdO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUud2lkdGggICAgPSAoaGRyWzRdIDw8IDgpICsgaGRyWzVdO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuaGVpZ2h0ICAgPSAoaGRyWzZdIDw8IDgpICsgaGRyWzddO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuZW5jb2RpbmcgPSBwYXJzZUludCgoaGRyWzhdIDw8IDI0KSArIChoZHJbOV0gPDwgMTYpICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKGhkclsxMF0gPDwgOCkgKyBoZHJbMTFdLCAxMCk7XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fb25GQlVSZWNlaXZlKHRoaXMsXG4gICAgICAgICAgICAgICAgICAgICAgICB7J3gnOiB0aGlzLl9GQlUueCwgJ3knOiB0aGlzLl9GQlUueSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAnd2lkdGgnOiB0aGlzLl9GQlUud2lkdGgsICdoZWlnaHQnOiB0aGlzLl9GQlUuaGVpZ2h0LFxuICAgICAgICAgICAgICAgICAgICAgICAgICdlbmNvZGluZyc6IHRoaXMuX0ZCVS5lbmNvZGluZyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAnZW5jb2RpbmdOYW1lJzogdGhpcy5fZW5jTmFtZXNbdGhpcy5fRkJVLmVuY29kaW5nXX0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghdGhpcy5fZW5jTmFtZXNbdGhpcy5fRkJVLmVuY29kaW5nXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmFpbChcIkRpc2Nvbm5lY3RlZDogdW5zdXBwb3J0ZWQgZW5jb2RpbmcgXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuZW5jb2RpbmcpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhpcy5fdGltaW5nLmxhc3RfZmJ1ID0gKG5ldyBEYXRlKCkpLmdldFRpbWUoKTtcblxuICAgICAgICAgICAgICAgIHJldCA9IHRoaXMuX2VuY0hhbmRsZXJzW3RoaXMuX0ZCVS5lbmNvZGluZ10oKTtcblxuICAgICAgICAgICAgICAgIG5vdyA9IChuZXcgRGF0ZSgpKS5nZXRUaW1lKCk7XG4gICAgICAgICAgICAgICAgdGhpcy5fdGltaW5nLmN1cl9mYnUgKz0gKG5vdyAtIHRoaXMuX3RpbWluZy5sYXN0X2ZidSk7XG5cbiAgICAgICAgICAgICAgICBpZiAocmV0KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2VuY1N0YXRzW3RoaXMuX0ZCVS5lbmNvZGluZ11bMF0rKztcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZW5jU3RhdHNbdGhpcy5fRkJVLmVuY29kaW5nXVsxXSsrO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl90aW1pbmcucGl4ZWxzICs9IHRoaXMuX0ZCVS53aWR0aCAqIHRoaXMuX0ZCVS5oZWlnaHQ7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3RpbWluZy5waXhlbHMgPj0gKHRoaXMuX2ZiX3dpZHRoICogdGhpcy5fZmJfaGVpZ2h0KSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoKHRoaXMuX0ZCVS53aWR0aCA9PT0gdGhpcy5fZmJfd2lkdGggJiYgdGhpcy5fRkJVLmhlaWdodCA9PT0gdGhpcy5fZmJfaGVpZ2h0KSB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdGltaW5nLmZidV9ydF9zdGFydCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5mdWxsX2ZidV90b3RhbCArPSB0aGlzLl90aW1pbmcuY3VyX2ZidTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5mdWxsX2ZidV9jbnQrKztcbiAgICAgICAgICAgICAgICAgICAgICAgIFV0aWwuSW5mbyhcIlRpbWluZyBvZiBmdWxsIEZCVSwgY3VycjogXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5jdXJfZmJ1ICsgXCIsIHRvdGFsOiBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdGltaW5nLmZ1bGxfZmJ1X3RvdGFsICsgXCIsIGNudDogXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5mdWxsX2ZidV9jbnQgKyBcIiwgYXZnOiBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKHRoaXMuX3RpbWluZy5mdWxsX2ZidV90b3RhbCAvIHRoaXMuX3RpbWluZy5mdWxsX2ZidV9jbnQpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl90aW1pbmcuZmJ1X3J0X3N0YXJ0ID4gMCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdmFyIGZidV9ydF9kaWZmID0gbm93IC0gdGhpcy5fdGltaW5nLmZidV9ydF9zdGFydDtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5mYnVfcnRfdG90YWwgKz0gZmJ1X3J0X2RpZmY7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl90aW1pbmcuZmJ1X3J0X2NudCsrO1xuICAgICAgICAgICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiZnVsbCBGQlUgcm91bmQtdHJpcCwgY3VyOiBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZmJ1X3J0X2RpZmYgKyBcIiwgdG90YWw6IFwiICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl90aW1pbmcuZmJ1X3J0X3RvdGFsICsgXCIsIGNudDogXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5mYnVfcnRfY250ICsgXCIsIGF2ZzogXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICh0aGlzLl90aW1pbmcuZmJ1X3J0X3RvdGFsIC8gdGhpcy5fdGltaW5nLmZidV9ydF9jbnQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5mYnVfcnRfc3RhcnQgPSAwO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFyZXQpIHsgcmV0dXJuIHJldDsgfSAgLy8gbmVlZCBtb3JlIGRhdGFcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhpcy5fb25GQlVDb21wbGV0ZSh0aGlzLFxuICAgICAgICAgICAgICAgICAgICB7J3gnOiB0aGlzLl9GQlUueCwgJ3knOiB0aGlzLl9GQlUueSxcbiAgICAgICAgICAgICAgICAgICAgICd3aWR0aCc6IHRoaXMuX0ZCVS53aWR0aCwgJ2hlaWdodCc6IHRoaXMuX0ZCVS5oZWlnaHQsXG4gICAgICAgICAgICAgICAgICAgICAnZW5jb2RpbmcnOiB0aGlzLl9GQlUuZW5jb2RpbmcsXG4gICAgICAgICAgICAgICAgICAgICAnZW5jb2RpbmdOYW1lJzogdGhpcy5fZW5jTmFtZXNbdGhpcy5fRkJVLmVuY29kaW5nXX0pO1xuXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTsgIC8vIFdlIGZpbmlzaGVkIHRoaXMgRkJVXG4gICAgICAgIH0sXG5cbiAgICAgICAgX3VwZGF0ZUNvbnRpbnVvdXNVcGRhdGVzOiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIGlmICghdGhpcy5fZW5hYmxlZENvbnRpbnVvdXNVcGRhdGVzKSB7IHJldHVybjsgfVxuXG4gICAgICAgICAgICBSRkIubWVzc2FnZXMuZW5hYmxlQ29udGludW91c1VwZGF0ZXModGhpcy5fc29jaywgdHJ1ZSwgMCwgMCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9mYl93aWR0aCwgdGhpcy5fZmJfaGVpZ2h0KTtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICBVdGlsLm1ha2VfcHJvcGVydGllcyhSRkIsIFtcbiAgICAgICAgWyd0YXJnZXQnLCAnd28nLCAnZG9tJ10sICAgICAgICAgICAgICAgIC8vIFZOQyBkaXNwbGF5IHJlbmRlcmluZyBDYW52YXMgb2JqZWN0XG4gICAgICAgIFsnZm9jdXNDb250YWluZXInLCAnd28nLCAnZG9tJ10sICAgICAgICAvLyBET00gZWxlbWVudCB0aGF0IGNhcHR1cmVzIGtleWJvYXJkIGlucHV0XG4gICAgICAgIFsnZW5jcnlwdCcsICdydycsICdib29sJ10sICAgICAgICAgICAgICAvLyBVc2UgVExTL1NTTC93c3MgZW5jcnlwdGlvblxuICAgICAgICBbJ3RydWVfY29sb3InLCAncncnLCAnYm9vbCddLCAgICAgICAgICAgLy8gUmVxdWVzdCB0cnVlIGNvbG9yIHBpeGVsIGRhdGFcbiAgICAgICAgWydsb2NhbF9jdXJzb3InLCAncncnLCAnYm9vbCddLCAgICAgICAgIC8vIFJlcXVlc3QgbG9jYWxseSByZW5kZXJlZCBjdXJzb3JcbiAgICAgICAgWydzaGFyZWQnLCAncncnLCAnYm9vbCddLCAgICAgICAgICAgICAgIC8vIFJlcXVlc3Qgc2hhcmVkIG1vZGVcbiAgICAgICAgWyd2aWV3X29ubHknLCAncncnLCAnYm9vbCddLCAgICAgICAgICAgIC8vIERpc2FibGUgY2xpZW50IG1vdXNlL2tleWJvYXJkXG4gICAgICAgIFsneHZwX3Bhc3N3b3JkX3NlcCcsICdydycsICdzdHInXSwgICAgICAvLyBTZXBhcmF0b3IgZm9yIFhWUCBwYXNzd29yZCBmaWVsZHNcbiAgICAgICAgWydkaXNjb25uZWN0VGltZW91dCcsICdydycsICdpbnQnXSwgICAgIC8vIFRpbWUgKHMpIHRvIHdhaXQgZm9yIGRpc2Nvbm5lY3Rpb25cbiAgICAgICAgWyd3c1Byb3RvY29scycsICdydycsICdhcnInXSwgICAgICAgICAgIC8vIFByb3RvY29scyB0byB1c2UgaW4gdGhlIFdlYlNvY2tldCBjb25uZWN0aW9uXG4gICAgICAgIFsncmVwZWF0ZXJJRCcsICdydycsICdzdHInXSwgICAgICAgICAgICAvLyBbVWx0cmFWTkNdIFJlcGVhdGVySUQgdG8gY29ubmVjdCB0b1xuICAgICAgICBbJ3ZpZXdwb3J0RHJhZycsICdydycsICdib29sJ10sICAgICAgICAgLy8gTW92ZSB0aGUgdmlld3BvcnQgb24gbW91c2UgZHJhZ3NcblxuICAgICAgICAvLyBDYWxsYmFjayBmdW5jdGlvbnNcbiAgICAgICAgWydvblVwZGF0ZVN0YXRlJywgJ3J3JywgJ2Z1bmMnXSwgICAgICAgIC8vIG9uVXBkYXRlU3RhdGUocmZiLCBzdGF0ZSwgb2xkc3RhdGUsIHN0YXR1c01zZyk6IFJGQiBzdGF0ZSB1cGRhdGUvY2hhbmdlXG4gICAgICAgIFsnb25QYXNzd29yZFJlcXVpcmVkJywgJ3J3JywgJ2Z1bmMnXSwgICAvLyBvblBhc3N3b3JkUmVxdWlyZWQocmZiKTogVk5DIHBhc3N3b3JkIGlzIHJlcXVpcmVkXG4gICAgICAgIFsnb25DbGlwYm9hcmQnLCAncncnLCAnZnVuYyddLCAgICAgICAgICAvLyBvbkNsaXBib2FyZChyZmIsIHRleHQpOiBSRkIgY2xpcGJvYXJkIGNvbnRlbnRzIHJlY2VpdmVkXG4gICAgICAgIFsnb25CZWxsJywgJ3J3JywgJ2Z1bmMnXSwgICAgICAgICAgICAgICAvLyBvbkJlbGwocmZiKTogUkZCIEJlbGwgbWVzc2FnZSByZWNlaXZlZFxuICAgICAgICBbJ29uRkJVUmVjZWl2ZScsICdydycsICdmdW5jJ10sICAgICAgICAgLy8gb25GQlVSZWNlaXZlKHJmYiwgZmJ1KTogUkZCIEZCVSByZWNlaXZlZCBidXQgbm90IHlldCBwcm9jZXNzZWRcbiAgICAgICAgWydvbkZCVUNvbXBsZXRlJywgJ3J3JywgJ2Z1bmMnXSwgICAgICAgIC8vIG9uRkJVQ29tcGxldGUocmZiLCBmYnUpOiBSRkIgRkJVIHJlY2VpdmVkIGFuZCBwcm9jZXNzZWRcbiAgICAgICAgWydvbkZCUmVzaXplJywgJ3J3JywgJ2Z1bmMnXSwgICAgICAgICAgIC8vIG9uRkJSZXNpemUocmZiLCB3aWR0aCwgaGVpZ2h0KTogZnJhbWUgYnVmZmVyIHJlc2l6ZWRcbiAgICAgICAgWydvbkRlc2t0b3BOYW1lJywgJ3J3JywgJ2Z1bmMnXSwgICAgICAgIC8vIG9uRGVza3RvcE5hbWUocmZiLCBuYW1lKTogZGVza3RvcCBuYW1lIHJlY2VpdmVkXG4gICAgICAgIFsnb25YdnBJbml0JywgJ3J3JywgJ2Z1bmMnXSAgICAgICAgICAgICAvLyBvblh2cEluaXQodmVyc2lvbik6IFhWUCBleHRlbnNpb25zIGFjdGl2ZSBmb3IgdGhpcyBjb25uZWN0aW9uXG4gICAgXSk7XG5cbiAgICBSRkIucHJvdG90eXBlLnNldF9sb2NhbF9jdXJzb3IgPSBmdW5jdGlvbiAoY3Vyc29yKSB7XG4gICAgICAgIGlmICghY3Vyc29yIHx8IChjdXJzb3IgaW4geycwJzogMSwgJ25vJzogMSwgJ2ZhbHNlJzogMX0pKSB7XG4gICAgICAgICAgICB0aGlzLl9sb2NhbF9jdXJzb3IgPSBmYWxzZTtcbiAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuZGlzYWJsZUxvY2FsQ3Vyc29yKCk7IC8vT25seSBzaG93IHNlcnZlci1zaWRlIGN1cnNvclxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKHRoaXMuX2Rpc3BsYXkuZ2V0X2N1cnNvcl91cmkoKSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX2xvY2FsX2N1cnNvciA9IHRydWU7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIFV0aWwuV2FybihcIkJyb3dzZXIgZG9lcyBub3Qgc3VwcG9ydCBsb2NhbCBjdXJzb3JcIik7XG4gICAgICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5kaXNhYmxlTG9jYWxDdXJzb3IoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH07XG5cbiAgICBSRkIucHJvdG90eXBlLmdldF9kaXNwbGF5ID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gdGhpcy5fZGlzcGxheTsgfTtcbiAgICBSRkIucHJvdG90eXBlLmdldF9rZXlib2FyZCA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuIHRoaXMuX2tleWJvYXJkOyB9O1xuICAgIFJGQi5wcm90b3R5cGUuZ2V0X21vdXNlID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gdGhpcy5fbW91c2U7IH07XG5cbiAgICAvLyBDbGFzcyBNZXRob2RzXG4gICAgUkZCLm1lc3NhZ2VzID0ge1xuICAgICAgICBrZXlFdmVudDogZnVuY3Rpb24gKHNvY2ssIGtleXN5bSwgZG93bikge1xuICAgICAgICAgICAgdmFyIGJ1ZmYgPSBzb2NrLl9zUTtcbiAgICAgICAgICAgIHZhciBvZmZzZXQgPSBzb2NrLl9zUWxlbjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXRdID0gNDsgIC8vIG1zZy10eXBlXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDFdID0gZG93bjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAyXSA9IDA7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDNdID0gMDtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA0XSA9IChrZXlzeW0gPj4gMjQpO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA1XSA9IChrZXlzeW0gPj4gMTYpO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA2XSA9IChrZXlzeW0gPj4gOCk7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDddID0ga2V5c3ltO1xuXG4gICAgICAgICAgICBzb2NrLl9zUWxlbiArPSA4O1xuICAgICAgICAgICAgc29jay5mbHVzaCgpO1xuICAgICAgICB9LFxuXG4gICAgICAgIFFFTVVFeHRlbmRlZEtleUV2ZW50OiBmdW5jdGlvbiAoc29jaywga2V5c3ltLCBkb3duLCBrZXljb2RlKSB7XG4gICAgICAgICAgICBmdW5jdGlvbiBnZXRSRkJrZXljb2RlKHh0X3NjYW5jb2RlKSB7XG4gICAgICAgICAgICAgICAgdmFyIHVwcGVyQnl0ZSA9IChrZXljb2RlID4+IDgpO1xuICAgICAgICAgICAgICAgIHZhciBsb3dlckJ5dGUgPSAoa2V5Y29kZSAmIDB4MDBmZik7XG4gICAgICAgICAgICAgICAgaWYgKHVwcGVyQnl0ZSA9PT0gMHhlMCAmJiBsb3dlckJ5dGUgPCAweDdmKSB7XG4gICAgICAgICAgICAgICAgICAgIGxvd2VyQnl0ZSA9IGxvd2VyQnl0ZSB8IDB4ODA7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBsb3dlckJ5dGU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiB4dF9zY2FuY29kZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFyIGJ1ZmYgPSBzb2NrLl9zUTtcbiAgICAgICAgICAgIHZhciBvZmZzZXQgPSBzb2NrLl9zUWxlbjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXRdID0gMjU1OyAvLyBtc2ctdHlwZVxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxXSA9IDA7IC8vIHN1YiBtc2ctdHlwZVxuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDJdID0gKGRvd24gPj4gOCk7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDNdID0gZG93bjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA0XSA9IChrZXlzeW0gPj4gMjQpO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA1XSA9IChrZXlzeW0gPj4gMTYpO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA2XSA9IChrZXlzeW0gPj4gOCk7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDddID0ga2V5c3ltO1xuXG4gICAgICAgICAgICB2YXIgUkZCa2V5Y29kZSA9IGdldFJGQmtleWNvZGUoa2V5Y29kZSk7XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgOF0gPSAoUkZCa2V5Y29kZSA+PiAyNCk7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDldID0gKFJGQmtleWNvZGUgPj4gMTYpO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxMF0gPSAoUkZCa2V5Y29kZSA+PiA4KTtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTFdID0gUkZCa2V5Y29kZTtcblxuICAgICAgICAgICAgc29jay5fc1FsZW4gKz0gMTI7XG4gICAgICAgICAgICBzb2NrLmZsdXNoKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgcG9pbnRlckV2ZW50OiBmdW5jdGlvbiAoc29jaywgeCwgeSwgbWFzaykge1xuICAgICAgICAgICAgdmFyIGJ1ZmYgPSBzb2NrLl9zUTtcbiAgICAgICAgICAgIHZhciBvZmZzZXQgPSBzb2NrLl9zUWxlbjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXRdID0gNTsgLy8gbXNnLXR5cGVcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxXSA9IG1hc2s7XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMl0gPSB4ID4+IDg7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDNdID0geDtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA0XSA9IHkgPj4gODtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNV0gPSB5O1xuXG4gICAgICAgICAgICBzb2NrLl9zUWxlbiArPSA2O1xuICAgICAgICAgICAgc29jay5mbHVzaCgpO1xuICAgICAgICB9LFxuXG4gICAgICAgIC8vIFRPRE8oZGlyZWN0eG1hbjEyKTogbWFrZSB0aGlzIHVuaWNvZGUgY29tcGF0aWJsZT9cbiAgICAgICAgY2xpZW50Q3V0VGV4dDogZnVuY3Rpb24gKHNvY2ssIHRleHQpIHtcbiAgICAgICAgICAgIHZhciBidWZmID0gc29jay5fc1E7XG4gICAgICAgICAgICB2YXIgb2Zmc2V0ID0gc29jay5fc1FsZW47XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0XSA9IDY7IC8vIG1zZy10eXBlXG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMV0gPSAwOyAvLyBwYWRkaW5nXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDJdID0gMDsgLy8gcGFkZGluZ1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAzXSA9IDA7IC8vIHBhZGRpbmdcblxuICAgICAgICAgICAgdmFyIG4gPSB0ZXh0Lmxlbmd0aDtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA0XSA9IG4gPj4gMjQ7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDVdID0gbiA+PiAxNjtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNl0gPSBuID4+IDg7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDddID0gbjtcblxuICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBuOyBpKyspIHtcbiAgICAgICAgICAgICAgICBidWZmW29mZnNldCArIDggKyBpXSA9ICB0ZXh0LmNoYXJDb2RlQXQoaSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHNvY2suX3NRbGVuICs9IDggKyBuO1xuICAgICAgICAgICAgc29jay5mbHVzaCgpO1xuICAgICAgICB9LFxuXG4gICAgICAgIHNldERlc2t0b3BTaXplOiBmdW5jdGlvbiAoc29jaywgd2lkdGgsIGhlaWdodCwgaWQsIGZsYWdzKSB7XG4gICAgICAgICAgICB2YXIgYnVmZiA9IHNvY2suX3NRO1xuICAgICAgICAgICAgdmFyIG9mZnNldCA9IHNvY2suX3NRbGVuO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldF0gPSAyNTE7ICAgICAgICAgICAgICAvLyBtc2ctdHlwZVxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxXSA9IDA7ICAgICAgICAgICAgLy8gcGFkZGluZ1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAyXSA9IHdpZHRoID4+IDg7ICAgLy8gd2lkdGhcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgM10gPSB3aWR0aDtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNF0gPSBoZWlnaHQgPj4gODsgIC8vIGhlaWdodFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA1XSA9IGhlaWdodDtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA2XSA9IDE7ICAgICAgICAgICAgLy8gbnVtYmVyLW9mLXNjcmVlbnNcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgN10gPSAwOyAgICAgICAgICAgIC8vIHBhZGRpbmdcblxuICAgICAgICAgICAgLy8gc2NyZWVuIGFycmF5XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDhdID0gaWQgPj4gMjQ7ICAgICAvLyBpZFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA5XSA9IGlkID4+IDE2O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxMF0gPSBpZCA+PiA4O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxMV0gPSBpZDtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTJdID0gMDsgICAgICAgICAgIC8vIHgtcG9zaXRpb25cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTNdID0gMDtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTRdID0gMDsgICAgICAgICAgIC8vIHktcG9zaXRpb25cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTVdID0gMDtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTZdID0gd2lkdGggPj4gODsgIC8vIHdpZHRoXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDE3XSA9IHdpZHRoO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxOF0gPSBoZWlnaHQgPj4gODsgLy8gaGVpZ2h0XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDE5XSA9IGhlaWdodDtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMjBdID0gZmxhZ3MgPj4gMjQ7IC8vIGZsYWdzXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDIxXSA9IGZsYWdzID4+IDE2O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAyMl0gPSBmbGFncyA+PiA4O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAyM10gPSBmbGFncztcblxuICAgICAgICAgICAgc29jay5fc1FsZW4gKz0gMjQ7XG4gICAgICAgICAgICBzb2NrLmZsdXNoKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgY2xpZW50RmVuY2U6IGZ1bmN0aW9uIChzb2NrLCBmbGFncywgcGF5bG9hZCkge1xuICAgICAgICAgICAgdmFyIGJ1ZmYgPSBzb2NrLl9zUTtcbiAgICAgICAgICAgIHZhciBvZmZzZXQgPSBzb2NrLl9zUWxlbjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXRdID0gMjQ4OyAvLyBtc2ctdHlwZVxuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDFdID0gMDsgLy8gcGFkZGluZ1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAyXSA9IDA7IC8vIHBhZGRpbmdcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgM10gPSAwOyAvLyBwYWRkaW5nXG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNF0gPSBmbGFncyA+PiAyNDsgLy8gZmxhZ3NcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNV0gPSBmbGFncyA+PiAxNjtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNl0gPSBmbGFncyA+PiA4O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA3XSA9IGZsYWdzO1xuXG4gICAgICAgICAgICB2YXIgbiA9IHBheWxvYWQubGVuZ3RoO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDhdID0gbjsgLy8gbGVuZ3RoXG5cbiAgICAgICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbjsgaSsrKSB7XG4gICAgICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA5ICsgaV0gPSBwYXlsb2FkLmNoYXJDb2RlQXQoaSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHNvY2suX3NRbGVuICs9IDkgKyBuO1xuICAgICAgICAgICAgc29jay5mbHVzaCgpO1xuICAgICAgICB9LFxuXG4gICAgICAgIGVuYWJsZUNvbnRpbnVvdXNVcGRhdGVzOiBmdW5jdGlvbiAoc29jaywgZW5hYmxlLCB4LCB5LCB3aWR0aCwgaGVpZ2h0KSB7XG4gICAgICAgICAgICB2YXIgYnVmZiA9IHNvY2suX3NRO1xuICAgICAgICAgICAgdmFyIG9mZnNldCA9IHNvY2suX3NRbGVuO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldF0gPSAxNTA7ICAgICAgICAgICAgIC8vIG1zZy10eXBlXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDFdID0gZW5hYmxlOyAgICAgIC8vIGVuYWJsZS1mbGFnXG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMl0gPSB4ID4+IDg7ICAgICAgLy8geFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAzXSA9IHg7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDRdID0geSA+PiA4OyAgICAgIC8vIHlcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNV0gPSB5O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA2XSA9IHdpZHRoID4+IDg7ICAvLyB3aWR0aFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA3XSA9IHdpZHRoO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA4XSA9IGhlaWdodCA+PiA4OyAvLyBoZWlnaHRcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgOV0gPSBoZWlnaHQ7XG5cbiAgICAgICAgICAgIHNvY2suX3NRbGVuICs9IDEwO1xuICAgICAgICAgICAgc29jay5mbHVzaCgpO1xuICAgICAgICB9LFxuXG4gICAgICAgIHBpeGVsRm9ybWF0OiBmdW5jdGlvbiAoc29jaywgYnBwLCBkZXB0aCwgdHJ1ZV9jb2xvcikge1xuICAgICAgICAgICAgdmFyIGJ1ZmYgPSBzb2NrLl9zUTtcbiAgICAgICAgICAgIHZhciBvZmZzZXQgPSBzb2NrLl9zUWxlbjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXRdID0gMDsgIC8vIG1zZy10eXBlXG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMV0gPSAwOyAvLyBwYWRkaW5nXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDJdID0gMDsgLy8gcGFkZGluZ1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAzXSA9IDA7IC8vIHBhZGRpbmdcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA0XSA9IGJwcCAqIDg7ICAgICAgICAgICAgIC8vIGJpdHMtcGVyLXBpeGVsXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDVdID0gZGVwdGggKiA4OyAgICAgICAgICAgLy8gZGVwdGhcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNl0gPSAwOyAgICAgICAgICAgICAgICAgICAvLyBsaXR0bGUtZW5kaWFuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDddID0gdHJ1ZV9jb2xvciA/IDEgOiAwOyAgLy8gdHJ1ZS1jb2xvclxuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDhdID0gMDsgICAgLy8gcmVkLW1heFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA5XSA9IDI1NTsgIC8vIHJlZC1tYXhcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxMF0gPSAwOyAgIC8vIGdyZWVuLW1heFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxMV0gPSAyNTU7IC8vIGdyZWVuLW1heFxuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDEyXSA9IDA7ICAgLy8gYmx1ZS1tYXhcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTNdID0gMjU1OyAvLyBibHVlLW1heFxuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDE0XSA9IDE2OyAgLy8gcmVkLXNoaWZ0XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDE1XSA9IDg7ICAgLy8gZ3JlZW4tc2hpZnRcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTZdID0gMDsgICAvLyBibHVlLXNoaWZ0XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTddID0gMDsgICAvLyBwYWRkaW5nXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDE4XSA9IDA7ICAgLy8gcGFkZGluZ1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxOV0gPSAwOyAgIC8vIHBhZGRpbmdcblxuICAgICAgICAgICAgc29jay5fc1FsZW4gKz0gMjA7XG4gICAgICAgICAgICBzb2NrLmZsdXNoKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgY2xpZW50RW5jb2RpbmdzOiBmdW5jdGlvbiAoc29jaywgZW5jb2RpbmdzLCBsb2NhbF9jdXJzb3IsIHRydWVfY29sb3IpIHtcbiAgICAgICAgICAgIHZhciBidWZmID0gc29jay5fc1E7XG4gICAgICAgICAgICB2YXIgb2Zmc2V0ID0gc29jay5fc1FsZW47XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0XSA9IDI7IC8vIG1zZy10eXBlXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDFdID0gMDsgLy8gcGFkZGluZ1xuXG4gICAgICAgICAgICAvLyBvZmZzZXQgKyAyIGFuZCBvZmZzZXQgKyAzIGFyZSBlbmNvZGluZyBjb3VudFxuXG4gICAgICAgICAgICB2YXIgaSwgaiA9IG9mZnNldCArIDQsIGNudCA9IDA7XG4gICAgICAgICAgICBmb3IgKGkgPSAwOyBpIDwgZW5jb2RpbmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVuY29kaW5nc1tpXVswXSA9PT0gXCJDdXJzb3JcIiAmJiAhbG9jYWxfY3Vyc29yKSB7XG4gICAgICAgICAgICAgICAgICAgIFV0aWwuRGVidWcoXCJTa2lwcGluZyBDdXJzb3IgcHNldWRvLWVuY29kaW5nXCIpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZW5jb2RpbmdzW2ldWzBdID09PSBcIlRJR0hUXCIgJiYgIXRydWVfY29sb3IpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gVE9ETzogcmVtb3ZlIHRoaXMgd2hlbiB3ZSBoYXZlIHRpZ2h0K25vbi10cnVlLWNvbG9yXG4gICAgICAgICAgICAgICAgICAgIFV0aWwuV2FybihcIlNraXBwaW5nIHRpZ2h0IGFzIGl0IGlzIG9ubHkgc3VwcG9ydGVkIHdpdGggdHJ1ZSBjb2xvclwiKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB2YXIgZW5jID0gZW5jb2RpbmdzW2ldWzFdO1xuICAgICAgICAgICAgICAgICAgICBidWZmW2pdID0gZW5jID4+IDI0O1xuICAgICAgICAgICAgICAgICAgICBidWZmW2ogKyAxXSA9IGVuYyA+PiAxNjtcbiAgICAgICAgICAgICAgICAgICAgYnVmZltqICsgMl0gPSBlbmMgPj4gODtcbiAgICAgICAgICAgICAgICAgICAgYnVmZltqICsgM10gPSBlbmM7XG5cbiAgICAgICAgICAgICAgICAgICAgaiArPSA0O1xuICAgICAgICAgICAgICAgICAgICBjbnQrKztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMl0gPSBjbnQgPj4gODtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgM10gPSBjbnQ7XG5cbiAgICAgICAgICAgIHNvY2suX3NRbGVuICs9IGogLSBvZmZzZXQ7XG4gICAgICAgICAgICBzb2NrLmZsdXNoKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgZmJVcGRhdGVSZXF1ZXN0czogZnVuY3Rpb24gKHNvY2ssIG9ubHlOb25JbmMsIGNsZWFuRGlydHksIGZiX3dpZHRoLCBmYl9oZWlnaHQpIHtcbiAgICAgICAgICAgIHZhciBvZmZzZXRJbmNyZW1lbnQgPSAwO1xuXG4gICAgICAgICAgICB2YXIgY2IgPSBjbGVhbkRpcnR5LmNsZWFuQm94O1xuICAgICAgICAgICAgdmFyIHcsIGg7XG4gICAgICAgICAgICBpZiAoIW9ubHlOb25JbmMgJiYgKGNiLncgPiAwICYmIGNiLmggPiAwKSkge1xuICAgICAgICAgICAgICAgIHcgPSB0eXBlb2YgY2IudyA9PT0gXCJ1bmRlZmluZWRcIiA/IGZiX3dpZHRoIDogY2IudztcbiAgICAgICAgICAgICAgICBoID0gdHlwZW9mIGNiLmggPT09IFwidW5kZWZpbmVkXCIgPyBmYl9oZWlnaHQgOiBjYi5oO1xuICAgICAgICAgICAgICAgIC8vIFJlcXVlc3QgaW5jcmVtZW50YWwgZm9yIGNsZWFuIGJveFxuICAgICAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5mYlVwZGF0ZVJlcXVlc3Qoc29jaywgMSwgY2IueCwgY2IueSwgdywgaCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgY2xlYW5EaXJ0eS5kaXJ0eUJveGVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgdmFyIGRiID0gY2xlYW5EaXJ0eS5kaXJ0eUJveGVzW2ldO1xuICAgICAgICAgICAgICAgIC8vIEZvcmNlIGFsbCAobm9uLWluY3JlbWVudGFsKSBmb3IgZGlydHkgYm94XG4gICAgICAgICAgICAgICAgdyA9IHR5cGVvZiBkYi53ID09PSBcInVuZGVmaW5lZFwiID8gZmJfd2lkdGggOiBkYi53O1xuICAgICAgICAgICAgICAgIGggPSB0eXBlb2YgZGIuaCA9PT0gXCJ1bmRlZmluZWRcIiA/IGZiX2hlaWdodCA6IGRiLmg7XG4gICAgICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmZiVXBkYXRlUmVxdWVzdChzb2NrLCAwLCBkYi54LCBkYi55LCB3LCBoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBmYlVwZGF0ZVJlcXVlc3Q6IGZ1bmN0aW9uIChzb2NrLCBpbmNyZW1lbnRhbCwgeCwgeSwgdywgaCkge1xuICAgICAgICAgICAgdmFyIGJ1ZmYgPSBzb2NrLl9zUTtcbiAgICAgICAgICAgIHZhciBvZmZzZXQgPSBzb2NrLl9zUWxlbjtcblxuICAgICAgICAgICAgaWYgKHR5cGVvZih4KSA9PT0gXCJ1bmRlZmluZWRcIikgeyB4ID0gMDsgfVxuICAgICAgICAgICAgaWYgKHR5cGVvZih5KSA9PT0gXCJ1bmRlZmluZWRcIikgeyB5ID0gMDsgfVxuXG4gICAgICAgICAgICBidWZmW29mZnNldF0gPSAzOyAgLy8gbXNnLXR5cGVcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMV0gPSBpbmNyZW1lbnRhbDtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAyXSA9ICh4ID4+IDgpICYgMHhGRjtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgM10gPSB4ICYgMHhGRjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA0XSA9ICh5ID4+IDgpICYgMHhGRjtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNV0gPSB5ICYgMHhGRjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA2XSA9ICh3ID4+IDgpICYgMHhGRjtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgN10gPSB3ICYgMHhGRjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA4XSA9IChoID4+IDgpICYgMHhGRjtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgOV0gPSBoICYgMHhGRjtcblxuICAgICAgICAgICAgc29jay5fc1FsZW4gKz0gMTA7XG4gICAgICAgICAgICBzb2NrLmZsdXNoKCk7XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgUkZCLmdlbkRFUyA9IGZ1bmN0aW9uIChwYXNzd29yZCwgY2hhbGxlbmdlKSB7XG4gICAgICAgIHZhciBwYXNzd2QgPSBbXTtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBwYXNzd29yZC5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgcGFzc3dkLnB1c2gocGFzc3dvcmQuY2hhckNvZGVBdChpKSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIChuZXcgREVTKHBhc3N3ZCkpLmVuY3J5cHQoY2hhbGxlbmdlKTtcbiAgICB9O1xuXG4gICAgUkZCLmV4dHJhY3RfZGF0YV91cmkgPSBmdW5jdGlvbiAoYXJyKSB7XG4gICAgICAgIHJldHVybiBcIjtiYXNlNjQsXCIgKyBCYXNlNjQuZW5jb2RlKGFycik7XG4gICAgfTtcblxuICAgIFJGQi5lbmNvZGluZ0hhbmRsZXJzID0ge1xuICAgICAgICBSQVc6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9GQlUubGluZXMgPT09IDApIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUubGluZXMgPSB0aGlzLl9GQlUuaGVpZ2h0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgPSB0aGlzLl9GQlUud2lkdGggKiB0aGlzLl9mYl9CcHA7ICAvLyBhdCBsZWFzdCBhIGxpbmVcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlJBV1wiLCB0aGlzLl9GQlUuYnl0ZXMpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgdmFyIGN1cl95ID0gdGhpcy5fRkJVLnkgKyAodGhpcy5fRkJVLmhlaWdodCAtIHRoaXMuX0ZCVS5saW5lcyk7XG4gICAgICAgICAgICB2YXIgY3Vycl9oZWlnaHQgPSBNYXRoLm1pbih0aGlzLl9GQlUubGluZXMsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBNYXRoLmZsb29yKHRoaXMuX3NvY2suclFsZW4oKSAvICh0aGlzLl9GQlUud2lkdGggKiB0aGlzLl9mYl9CcHApKSk7XG4gICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmJsaXRJbWFnZSh0aGlzLl9GQlUueCwgY3VyX3ksIHRoaXMuX0ZCVS53aWR0aCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJfaGVpZ2h0LCB0aGlzLl9zb2NrLmdldF9yUSgpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5nZXRfclFpKCkpO1xuICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcyh0aGlzLl9GQlUud2lkdGggKiBjdXJyX2hlaWdodCAqIHRoaXMuX2ZiX0JwcCk7XG4gICAgICAgICAgICB0aGlzLl9GQlUubGluZXMgLT0gY3Vycl9oZWlnaHQ7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9GQlUubGluZXMgPiAwKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gdGhpcy5fRkJVLndpZHRoICogdGhpcy5fZmJfQnBwOyAgLy8gQXQgbGVhc3QgYW5vdGhlciBsaW5lXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5yZWN0cy0tO1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDA7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIENPUFlSRUNUOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgPSA0O1xuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiQ09QWVJFQ1RcIiwgNCkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmNvcHlJbWFnZSh0aGlzLl9zb2NrLnJRc2hpZnQxNigpLCB0aGlzLl9zb2NrLnJRc2hpZnQxNigpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLngsIHRoaXMuX0ZCVS55LCB0aGlzLl9GQlUud2lkdGgsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuaGVpZ2h0KTtcblxuICAgICAgICAgICAgdGhpcy5fRkJVLnJlY3RzLS07XG4gICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgPSAwO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgUlJFOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB2YXIgY29sb3I7XG4gICAgICAgICAgICBpZiAodGhpcy5fRkJVLnN1YnJlY3RzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gNCArIHRoaXMuX2ZiX0JwcDtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJSUkVcIiwgNCArIHRoaXMuX2ZiX0JwcCkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLnN1YnJlY3RzID0gdGhpcy5fc29jay5yUXNoaWZ0MzIoKTtcbiAgICAgICAgICAgICAgICBjb2xvciA9IHRoaXMuX3NvY2suclFzaGlmdEJ5dGVzKHRoaXMuX2ZiX0JwcCk7ICAvLyBCYWNrZ3JvdW5kXG4gICAgICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5maWxsUmVjdCh0aGlzLl9GQlUueCwgdGhpcy5fRkJVLnksIHRoaXMuX0ZCVS53aWR0aCwgdGhpcy5fRkJVLmhlaWdodCwgY29sb3IpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB3aGlsZSAodGhpcy5fRkJVLnN1YnJlY3RzID4gMCAmJiB0aGlzLl9zb2NrLnJRbGVuKCkgPj0gKHRoaXMuX2ZiX0JwcCArIDgpKSB7XG4gICAgICAgICAgICAgICAgY29sb3IgPSB0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyh0aGlzLl9mYl9CcHApO1xuICAgICAgICAgICAgICAgIHZhciB4ID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgICAgICB2YXIgeSA9IHRoaXMuX3NvY2suclFzaGlmdDE2KCk7XG4gICAgICAgICAgICAgICAgdmFyIHdpZHRoID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgICAgICB2YXIgaGVpZ2h0ID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmZpbGxSZWN0KHRoaXMuX0ZCVS54ICsgeCwgdGhpcy5fRkJVLnkgKyB5LCB3aWR0aCwgaGVpZ2h0LCBjb2xvcik7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLnN1YnJlY3RzLS07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9GQlUuc3VicmVjdHMgPiAwKSB7XG4gICAgICAgICAgICAgICAgdmFyIGNodW5rID0gTWF0aC5taW4odGhpcy5fcnJlX2NodW5rX3N6LCB0aGlzLl9GQlUuc3VicmVjdHMpO1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9ICh0aGlzLl9mYl9CcHAgKyA4KSAqIGNodW5rO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUucmVjdHMtLTtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgPSAwO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBIRVhUSUxFOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB2YXIgclEgPSB0aGlzLl9zb2NrLmdldF9yUSgpO1xuICAgICAgICAgICAgdmFyIHJRaSA9IHRoaXMuX3NvY2suZ2V0X3JRaSgpO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5fRkJVLnRpbGVzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLnRpbGVzX3ggPSBNYXRoLmNlaWwodGhpcy5fRkJVLndpZHRoIC8gMTYpO1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS50aWxlc195ID0gTWF0aC5jZWlsKHRoaXMuX0ZCVS5oZWlnaHQgLyAxNik7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLnRvdGFsX3RpbGVzID0gdGhpcy5fRkJVLnRpbGVzX3ggKiB0aGlzLl9GQlUudGlsZXNfeTtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUudGlsZXMgPSB0aGlzLl9GQlUudG90YWxfdGlsZXM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHdoaWxlICh0aGlzLl9GQlUudGlsZXMgPiAwKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gMTtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJIRVhUSUxFIHN1YmVuY29kaW5nXCIsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICAgICAgdmFyIHN1YmVuY29kaW5nID0gclFbclFpXTsgIC8vIFBlZWtcbiAgICAgICAgICAgICAgICBpZiAoc3ViZW5jb2RpbmcgPiAzMCkgeyAgLy8gUmF3XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZhaWwoXCJEaXNjb25uZWN0ZWQ6IGlsbGVnYWwgaGV4dGlsZSBzdWJlbmNvZGluZyBcIiArIHN1YmVuY29kaW5nKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHZhciBzdWJyZWN0cyA9IDA7XG4gICAgICAgICAgICAgICAgdmFyIGN1cnJfdGlsZSA9IHRoaXMuX0ZCVS50b3RhbF90aWxlcyAtIHRoaXMuX0ZCVS50aWxlcztcbiAgICAgICAgICAgICAgICB2YXIgdGlsZV94ID0gY3Vycl90aWxlICUgdGhpcy5fRkJVLnRpbGVzX3g7XG4gICAgICAgICAgICAgICAgdmFyIHRpbGVfeSA9IE1hdGguZmxvb3IoY3Vycl90aWxlIC8gdGhpcy5fRkJVLnRpbGVzX3gpO1xuICAgICAgICAgICAgICAgIHZhciB4ID0gdGhpcy5fRkJVLnggKyB0aWxlX3ggKiAxNjtcbiAgICAgICAgICAgICAgICB2YXIgeSA9IHRoaXMuX0ZCVS55ICsgdGlsZV95ICogMTY7XG4gICAgICAgICAgICAgICAgdmFyIHcgPSBNYXRoLm1pbigxNiwgKHRoaXMuX0ZCVS54ICsgdGhpcy5fRkJVLndpZHRoKSAtIHgpO1xuICAgICAgICAgICAgICAgIHZhciBoID0gTWF0aC5taW4oMTYsICh0aGlzLl9GQlUueSArIHRoaXMuX0ZCVS5oZWlnaHQpIC0geSk7XG5cbiAgICAgICAgICAgICAgICAvLyBGaWd1cmUgb3V0IGhvdyBtdWNoIHdlIGFyZSBleHBlY3RpbmdcbiAgICAgICAgICAgICAgICBpZiAoc3ViZW5jb2RpbmcgJiAweDAxKSB7ICAvLyBSYXdcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzICs9IHcgKiBoICogdGhpcy5fZmJfQnBwO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJlbmNvZGluZyAmIDB4MDIpIHsgIC8vIEJhY2tncm91bmRcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyArPSB0aGlzLl9mYl9CcHA7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YmVuY29kaW5nICYgMHgwNCkgeyAgLy8gRm9yZWdyb3VuZFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzICs9IHRoaXMuX2ZiX0JwcDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViZW5jb2RpbmcgJiAweDA4KSB7ICAvLyBBbnlTdWJyZWN0c1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzKys7ICAvLyBTaW5jZSB3ZSBhcmVuJ3Qgc2hpZnRpbmcgaXQgb2ZmXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJoZXh0aWxlIHN1YnJlY3RzIGhlYWRlclwiLCB0aGlzLl9GQlUuYnl0ZXMpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgc3VicmVjdHMgPSByUVtyUWkgKyB0aGlzLl9GQlUuYnl0ZXMgLSAxXTsgIC8vIFBlZWtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChzdWJlbmNvZGluZyAmIDB4MTApIHsgIC8vIFN1YnJlY3RzQ29sb3VyZWRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgKz0gc3VicmVjdHMgKiAodGhpcy5fZmJfQnBwICsgMik7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyArPSBzdWJyZWN0cyAqIDI7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJoZXh0aWxlXCIsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgICAgICAvLyBXZSBrbm93IHRoZSBlbmNvZGluZyBhbmQgaGF2ZSBhIHdob2xlIHRpbGVcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUuc3ViZW5jb2RpbmcgPSByUVtyUWldO1xuICAgICAgICAgICAgICAgIHJRaSsrO1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9GQlUuc3ViZW5jb2RpbmcgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX0ZCVS5sYXN0c3ViZW5jb2RpbmcgJiAweDAxKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBXZWlyZDogaWdub3JlIGJsYW5rcyBhcmUgUkFXXG4gICAgICAgICAgICAgICAgICAgICAgICBVdGlsLkRlYnVnKFwiICAgICBJZ25vcmluZyBibGFuayBhZnRlciBSQVdcIik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmZpbGxSZWN0KHgsIHksIHcsIGgsIHRoaXMuX0ZCVS5iYWNrZ3JvdW5kKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy5fRkJVLnN1YmVuY29kaW5nICYgMHgwMSkgeyAgLy8gUmF3XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuYmxpdEltYWdlKHgsIHksIHcsIGgsIHJRLCByUWkpO1xuICAgICAgICAgICAgICAgICAgICByUWkgKz0gdGhpcy5fRkJVLmJ5dGVzIC0gMTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fRkJVLnN1YmVuY29kaW5nICYgMHgwMikgeyAgLy8gQmFja2dyb3VuZFxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX2ZiX0JwcCA9PSAxKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJhY2tncm91bmQgPSByUVtyUWldO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBmYl9CcHAgaXMgNFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5iYWNrZ3JvdW5kID0gW3JRW3JRaV0sIHJRW3JRaSArIDFdLCByUVtyUWkgKyAyXSwgclFbclFpICsgM11dO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgclFpICs9IHRoaXMuX2ZiX0JwcDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fRkJVLnN1YmVuY29kaW5nICYgMHgwNCkgeyAgLy8gRm9yZWdyb3VuZFxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX2ZiX0JwcCA9PSAxKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmZvcmVncm91bmQgPSByUVtyUWldO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyB0aGlzLl9mYl9CcHAgaXMgNFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5mb3JlZ3JvdW5kID0gW3JRW3JRaV0sIHJRW3JRaSArIDFdLCByUVtyUWkgKyAyXSwgclFbclFpICsgM11dO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgclFpICs9IHRoaXMuX2ZiX0JwcDtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuc3RhcnRUaWxlKHgsIHksIHcsIGgsIHRoaXMuX0ZCVS5iYWNrZ3JvdW5kKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX0ZCVS5zdWJlbmNvZGluZyAmIDB4MDgpIHsgIC8vIEFueVN1YnJlY3RzXG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJyZWN0cyA9IHJRW3JRaV07XG4gICAgICAgICAgICAgICAgICAgICAgICByUWkrKztcblxuICAgICAgICAgICAgICAgICAgICAgICAgZm9yICh2YXIgcyA9IDA7IHMgPCBzdWJyZWN0czsgcysrKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFyIGNvbG9yO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9GQlUuc3ViZW5jb2RpbmcgJiAweDEwKSB7ICAvLyBTdWJyZWN0c0NvbG91cmVkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9mYl9CcHAgPT09IDEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbG9yID0gclFbclFpXTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIF9mYl9CcHAgaXMgNFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3IgPSBbclFbclFpXSwgclFbclFpICsgMV0sIHJRW3JRaSArIDJdLCByUVtyUWkgKyAzXV07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgclFpICs9IHRoaXMuX2ZiX0JwcDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb2xvciA9IHRoaXMuX0ZCVS5mb3JlZ3JvdW5kO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YXIgeHkgPSByUVtyUWldO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJRaSsrO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhciBzeCA9ICh4eSA+PiA0KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YXIgc3kgPSAoeHkgJiAweDBmKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhciB3aCA9IHJRW3JRaV07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgclFpKys7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFyIHN3ID0gKHdoID4+IDQpICsgMTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YXIgc2ggPSAod2ggJiAweDBmKSArIDE7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LnN1YlRpbGUoc3gsIHN5LCBzdywgc2gsIGNvbG9yKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmZpbmlzaFRpbGUoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5zZXRfclFpKHJRaSk7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLmxhc3RzdWJlbmNvZGluZyA9IHRoaXMuX0ZCVS5zdWJlbmNvZGluZztcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgPSAwO1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS50aWxlcy0tO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5fRkJVLnRpbGVzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLnJlY3RzLS07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIGdldFRpZ2h0Q0xlbmd0aDogZnVuY3Rpb24gKGFycikge1xuICAgICAgICAgICAgdmFyIGhlYWRlciA9IDEsIGRhdGEgPSAwO1xuICAgICAgICAgICAgZGF0YSArPSBhcnJbMF0gJiAweDdmO1xuICAgICAgICAgICAgaWYgKGFyclswXSAmIDB4ODApIHtcbiAgICAgICAgICAgICAgICBoZWFkZXIrKztcbiAgICAgICAgICAgICAgICBkYXRhICs9IChhcnJbMV0gJiAweDdmKSA8PCA3O1xuICAgICAgICAgICAgICAgIGlmIChhcnJbMV0gJiAweDgwKSB7XG4gICAgICAgICAgICAgICAgICAgIGhlYWRlcisrO1xuICAgICAgICAgICAgICAgICAgICBkYXRhICs9IGFyclsyXSA8PCAxNDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gW2hlYWRlciwgZGF0YV07XG4gICAgICAgIH0sXG5cbiAgICAgICAgZGlzcGxheV90aWdodDogZnVuY3Rpb24gKGlzVGlnaHRQTkcpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9mYl9kZXB0aCA9PT0gMSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX2ZhaWwoXCJUaWdodCBwcm90b2NvbCBoYW5kbGVyIG9ubHkgaW1wbGVtZW50cyB0cnVlIGNvbG9yIG1vZGVcIik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDE7ICAvLyBjb21wcmVzc2lvbi1jb250cm9sIGJ5dGVcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlRJR0hUIGNvbXByZXNzaW9uLWNvbnRyb2xcIiwgdGhpcy5fRkJVLmJ5dGVzKSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgdmFyIGNoZWNrc3VtID0gZnVuY3Rpb24gKGRhdGEpIHtcbiAgICAgICAgICAgICAgICB2YXIgc3VtID0gMDtcbiAgICAgICAgICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGRhdGEubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgICAgICAgc3VtICs9IGRhdGFbaV07XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdW0gPiA2NTUzNikgc3VtIC09IDY1NTM2O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gc3VtO1xuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgdmFyIHJlc2V0U3RyZWFtcyA9IDA7XG4gICAgICAgICAgICB2YXIgc3RyZWFtSWQgPSAtMTtcbiAgICAgICAgICAgIHZhciBkZWNvbXByZXNzID0gZnVuY3Rpb24gKGRhdGEsIGV4cGVjdGVkKSB7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCA0OyBpKyspIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKChyZXNldFN0cmVhbXMgPj4gaSkgJiAxKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuemxpYnNbaV0ucmVzZXQoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIFV0aWwuSW5mbyhcIlJlc2V0IHpsaWIgc3RyZWFtIFwiICsgaSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL3ZhciB1bmNvbXByZXNzZWQgPSB0aGlzLl9GQlUuemxpYnNbc3RyZWFtSWRdLnVuY29tcHJlc3MoZGF0YSwgMCk7XG4gICAgICAgICAgICAgICAgdmFyIHVuY29tcHJlc3NlZCA9IHRoaXMuX0ZCVS56bGlic1tzdHJlYW1JZF0uaW5mbGF0ZShkYXRhLCB0cnVlLCBleHBlY3RlZCk7XG4gICAgICAgICAgICAgICAgLyppZiAodW5jb21wcmVzc2VkLnN0YXR1cyAhPT0gMCkge1xuICAgICAgICAgICAgICAgICAgICBVdGlsLkVycm9yKFwiSW52YWxpZCBkYXRhIGluIHpsaWIgc3RyZWFtXCIpO1xuICAgICAgICAgICAgICAgIH0qL1xuXG4gICAgICAgICAgICAgICAgLy9yZXR1cm4gdW5jb21wcmVzc2VkLmRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHVuY29tcHJlc3NlZDtcbiAgICAgICAgICAgIH0uYmluZCh0aGlzKTtcblxuICAgICAgICAgICAgdmFyIGluZGV4ZWRUb1JHQlgyQ29sb3IgPSBmdW5jdGlvbiAoZGF0YSwgcGFsZXR0ZSwgd2lkdGgsIGhlaWdodCkge1xuICAgICAgICAgICAgICAgIC8vIENvbnZlcnQgaW5kZXhlZCAocGFsZXR0ZSBiYXNlZCkgaW1hZ2UgZGF0YSB0byBSR0JcbiAgICAgICAgICAgICAgICAvLyBUT0RPOiByZWR1Y2UgbnVtYmVyIG9mIGNhbGN1bGF0aW9ucyBpbnNpZGUgbG9vcFxuICAgICAgICAgICAgICAgIHZhciBkZXN0ID0gdGhpcy5fZGVzdEJ1ZmY7XG4gICAgICAgICAgICAgICAgdmFyIHcgPSBNYXRoLmZsb29yKCh3aWR0aCArIDcpIC8gOCk7XG4gICAgICAgICAgICAgICAgdmFyIHcxID0gTWF0aC5mbG9vcih3aWR0aCAvIDgpO1xuXG4gICAgICAgICAgICAgICAgLypmb3IgKHZhciB5ID0gMDsgeSA8IGhlaWdodDsgeSsrKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBiLCB4LCBkcCwgc3A7XG4gICAgICAgICAgICAgICAgICAgIHZhciB5b2Zmc2V0ID0geSAqIHdpZHRoO1xuICAgICAgICAgICAgICAgICAgICB2YXIgeWJpdG9mZnNldCA9IHkgKiB3O1xuICAgICAgICAgICAgICAgICAgICB2YXIgeG9mZnNldCwgdGFyZ2V0Ynl0ZTtcbiAgICAgICAgICAgICAgICAgICAgZm9yICh4ID0gMDsgeCA8IHcxOyB4KyspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHhvZmZzZXQgPSB5b2Zmc2V0ICsgeCAqIDg7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXRieXRlID0gZGF0YVt5Yml0b2Zmc2V0ICsgeF07XG4gICAgICAgICAgICAgICAgICAgICAgICBmb3IgKGIgPSA3OyBiID49IDA7IGItLSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRwID0gKHhvZmZzZXQgKyA3IC0gYikgKiAzO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNwID0gKHRhcmdldGJ5dGUgPj4gYiAmIDEpICogMztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0W2RwXSA9IHBhbGV0dGVbc3BdO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RbZHAgKyAxXSA9IHBhbGV0dGVbc3AgKyAxXTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0W2RwICsgMl0gPSBwYWxldHRlW3NwICsgMl07XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB4b2Zmc2V0ID0geW9mZnNldCArIHggKiA4O1xuICAgICAgICAgICAgICAgICAgICB0YXJnZXRieXRlID0gZGF0YVt5Yml0b2Zmc2V0ICsgeF07XG4gICAgICAgICAgICAgICAgICAgIGZvciAoYiA9IDc7IGIgPj0gOCAtIHdpZHRoICUgODsgYi0tKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkcCA9ICh4b2Zmc2V0ICsgNyAtIGIpICogMztcbiAgICAgICAgICAgICAgICAgICAgICAgIHNwID0gKHRhcmdldGJ5dGUgPj4gYiAmIDEpICogMztcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RbZHBdID0gcGFsZXR0ZVtzcF07XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0W2RwICsgMV0gPSBwYWxldHRlW3NwICsgMV07XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0W2RwICsgMl0gPSBwYWxldHRlW3NwICsgMl07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9Ki9cblxuICAgICAgICAgICAgICAgIGZvciAodmFyIHkgPSAwOyB5IDwgaGVpZ2h0OyB5KyspIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGIsIHgsIGRwLCBzcDtcbiAgICAgICAgICAgICAgICAgICAgZm9yICh4ID0gMDsgeCA8IHcxOyB4KyspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvciAoYiA9IDc7IGIgPj0gMDsgYi0tKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZHAgPSAoeSAqIHdpZHRoICsgeCAqIDggKyA3IC0gYikgKiA0O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNwID0gKGRhdGFbeSAqIHcgKyB4XSA+PiBiICYgMSkgKiAzO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RbZHBdID0gcGFsZXR0ZVtzcF07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVzdFtkcCArIDFdID0gcGFsZXR0ZVtzcCArIDFdO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RbZHAgKyAyXSA9IHBhbGV0dGVbc3AgKyAyXTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0W2RwICsgM10gPSAyNTU7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBmb3IgKGIgPSA3OyBiID49IDggLSB3aWR0aCAlIDg7IGItLSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZHAgPSAoeSAqIHdpZHRoICsgeCAqIDggKyA3IC0gYikgKiA0O1xuICAgICAgICAgICAgICAgICAgICAgICAgc3AgPSAoZGF0YVt5ICogdyArIHhdID4+IGIgJiAxKSAqIDM7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0W2RwXSA9IHBhbGV0dGVbc3BdO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdFtkcCArIDFdID0gcGFsZXR0ZVtzcCArIDFdO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdFtkcCArIDJdID0gcGFsZXR0ZVtzcCArIDJdO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdFtkcCArIDNdID0gMjU1O1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGRlc3Q7XG4gICAgICAgICAgICB9LmJpbmQodGhpcyk7XG5cbiAgICAgICAgICAgIHZhciBpbmRleGVkVG9SR0JYID0gZnVuY3Rpb24gKGRhdGEsIHBhbGV0dGUsIHdpZHRoLCBoZWlnaHQpIHtcbiAgICAgICAgICAgICAgICAvLyBDb252ZXJ0IGluZGV4ZWQgKHBhbGV0dGUgYmFzZWQpIGltYWdlIGRhdGEgdG8gUkdCXG4gICAgICAgICAgICAgICAgdmFyIGRlc3QgPSB0aGlzLl9kZXN0QnVmZjtcbiAgICAgICAgICAgICAgICB2YXIgdG90YWwgPSB3aWR0aCAqIGhlaWdodCAqIDQ7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgaSA9IDAsIGogPSAwOyBpIDwgdG90YWw7IGkgKz0gNCwgaisrKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBzcCA9IGRhdGFbal0gKiAzO1xuICAgICAgICAgICAgICAgICAgICBkZXN0W2ldID0gcGFsZXR0ZVtzcF07XG4gICAgICAgICAgICAgICAgICAgIGRlc3RbaSArIDFdID0gcGFsZXR0ZVtzcCArIDFdO1xuICAgICAgICAgICAgICAgICAgICBkZXN0W2kgKyAyXSA9IHBhbGV0dGVbc3AgKyAyXTtcbiAgICAgICAgICAgICAgICAgICAgZGVzdFtpICsgM10gPSAyNTU7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGRlc3Q7XG4gICAgICAgICAgICB9LmJpbmQodGhpcyk7XG5cbiAgICAgICAgICAgIHZhciByUWkgPSB0aGlzLl9zb2NrLmdldF9yUWkoKTtcbiAgICAgICAgICAgIHZhciByUSA9IHRoaXMuX3NvY2suclF3aG9sZSgpO1xuICAgICAgICAgICAgdmFyIGNtb2RlLCBkYXRhO1xuICAgICAgICAgICAgdmFyIGNsX2hlYWRlciwgY2xfZGF0YTtcblxuICAgICAgICAgICAgdmFyIGhhbmRsZVBhbGV0dGUgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgdmFyIG51bUNvbG9ycyA9IHJRW3JRaSArIDJdICsgMTtcbiAgICAgICAgICAgICAgICB2YXIgcGFsZXR0ZVNpemUgPSBudW1Db2xvcnMgKiB0aGlzLl9mYl9kZXB0aDtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgKz0gcGFsZXR0ZVNpemU7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiVElHSFQgcGFsZXR0ZSBcIiArIGNtb2RlLCB0aGlzLl9GQlUuYnl0ZXMpKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgICAgICAgICAgICAgdmFyIGJwcCA9IChudW1Db2xvcnMgPD0gMikgPyAxIDogODtcbiAgICAgICAgICAgICAgICB2YXIgcm93U2l6ZSA9IE1hdGguZmxvb3IoKHRoaXMuX0ZCVS53aWR0aCAqIGJwcCArIDcpIC8gOCk7XG4gICAgICAgICAgICAgICAgdmFyIHJhdyA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIGlmIChyb3dTaXplICogdGhpcy5fRkJVLmhlaWdodCA8IDEyKSB7XG4gICAgICAgICAgICAgICAgICAgIHJhdyA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGNsX2hlYWRlciA9IDA7XG4gICAgICAgICAgICAgICAgICAgIGNsX2RhdGEgPSByb3dTaXplICogdGhpcy5fRkJVLmhlaWdodDtcbiAgICAgICAgICAgICAgICAgICAgLy9jbGVuZ3RoID0gWzAsIHJvd1NpemUgKiB0aGlzLl9GQlUuaGVpZ2h0XTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvLyBiZWdpbiBpbmxpbmUgZ2V0VGlnaHRDTGVuZ3RoIChyZXR1cm5pbmcgdHdvLWl0ZW0gYXJyYXlzIGlzIGJhZCBmb3IgcGVyZm9ybWFuY2Ugd2l0aCBHQylcbiAgICAgICAgICAgICAgICAgICAgdmFyIGNsX29mZnNldCA9IHJRaSArIDMgKyBwYWxldHRlU2l6ZTtcbiAgICAgICAgICAgICAgICAgICAgY2xfaGVhZGVyID0gMTtcbiAgICAgICAgICAgICAgICAgICAgY2xfZGF0YSA9IDA7XG4gICAgICAgICAgICAgICAgICAgIGNsX2RhdGEgKz0gclFbY2xfb2Zmc2V0XSAmIDB4N2Y7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyUVtjbF9vZmZzZXRdICYgMHg4MCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2xfaGVhZGVyKys7XG4gICAgICAgICAgICAgICAgICAgICAgICBjbF9kYXRhICs9IChyUVtjbF9vZmZzZXQgKyAxXSAmIDB4N2YpIDw8IDc7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoclFbY2xfb2Zmc2V0ICsgMV0gJiAweDgwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2xfaGVhZGVyKys7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2xfZGF0YSArPSByUVtjbF9vZmZzZXQgKyAyXSA8PCAxNDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAvLyBlbmQgaW5saW5lIGdldFRpZ2h0Q0xlbmd0aFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyArPSBjbF9oZWFkZXIgKyBjbF9kYXRhO1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlRJR0hUIFwiICsgY21vZGUsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgICAgICAvLyBTaGlmdCBjdGwsIGZpbHRlciBpZCwgbnVtIGNvbG9ycywgcGFsZXR0ZSBlbnRyaWVzLCBhbmQgY2xlbmd0aCBvZmZcbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKDMpO1xuICAgICAgICAgICAgICAgIC8vdmFyIHBhbGV0dGUgPSB0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyhwYWxldHRlU2l6ZSk7XG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNoaWZ0VG8odGhpcy5fcGFsZXR0ZUJ1ZmYsIHBhbGV0dGVTaXplKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKGNsX2hlYWRlcik7XG5cbiAgICAgICAgICAgICAgICBpZiAocmF3KSB7XG4gICAgICAgICAgICAgICAgICAgIGRhdGEgPSB0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyhjbF9kYXRhKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBkYXRhID0gZGVjb21wcmVzcyh0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyhjbF9kYXRhKSwgcm93U2l6ZSAqIHRoaXMuX0ZCVS5oZWlnaHQpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vIENvbnZlcnQgaW5kZXhlZCAocGFsZXR0ZSBiYXNlZCkgaW1hZ2UgZGF0YSB0byBSR0JcbiAgICAgICAgICAgICAgICB2YXIgcmdieDtcbiAgICAgICAgICAgICAgICBpZiAobnVtQ29sb3JzID09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgcmdieCA9IGluZGV4ZWRUb1JHQlgyQ29sb3IoZGF0YSwgdGhpcy5fcGFsZXR0ZUJ1ZmYsIHRoaXMuX0ZCVS53aWR0aCwgdGhpcy5fRkJVLmhlaWdodCk7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuYmxpdFJnYnhJbWFnZSh0aGlzLl9GQlUueCwgdGhpcy5fRkJVLnksIHRoaXMuX0ZCVS53aWR0aCwgdGhpcy5fRkJVLmhlaWdodCwgcmdieCwgMCwgZmFsc2UpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJnYnggPSBpbmRleGVkVG9SR0JYKGRhdGEsIHRoaXMuX3BhbGV0dGVCdWZmLCB0aGlzLl9GQlUud2lkdGgsIHRoaXMuX0ZCVS5oZWlnaHQpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmJsaXRSZ2J4SW1hZ2UodGhpcy5fRkJVLngsIHRoaXMuX0ZCVS55LCB0aGlzLl9GQlUud2lkdGgsIHRoaXMuX0ZCVS5oZWlnaHQsIHJnYngsIDAsIGZhbHNlKTtcbiAgICAgICAgICAgICAgICB9XG5cblxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfS5iaW5kKHRoaXMpO1xuXG4gICAgICAgICAgICB2YXIgaGFuZGxlQ29weSA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICB2YXIgcmF3ID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgdmFyIHVuY29tcHJlc3NlZFNpemUgPSB0aGlzLl9GQlUud2lkdGggKiB0aGlzLl9GQlUuaGVpZ2h0ICogdGhpcy5fZmJfZGVwdGg7XG4gICAgICAgICAgICAgICAgaWYgKHVuY29tcHJlc3NlZFNpemUgPCAxMikge1xuICAgICAgICAgICAgICAgICAgICByYXcgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIgPSAwO1xuICAgICAgICAgICAgICAgICAgICBjbF9kYXRhID0gdW5jb21wcmVzc2VkU2l6ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvLyBiZWdpbiBpbmxpbmUgZ2V0VGlnaHRDTGVuZ3RoIChyZXR1cm5pbmcgdHdvLWl0ZW0gYXJyYXlzIGlzIGZvciBwZWZvcm1hbmNlIHdpdGggR0MpXG4gICAgICAgICAgICAgICAgICAgIHZhciBjbF9vZmZzZXQgPSByUWkgKyAxO1xuICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIgPSAxO1xuICAgICAgICAgICAgICAgICAgICBjbF9kYXRhID0gMDtcbiAgICAgICAgICAgICAgICAgICAgY2xfZGF0YSArPSByUVtjbF9vZmZzZXRdICYgMHg3ZjtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJRW2NsX29mZnNldF0gJiAweDgwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIrKztcbiAgICAgICAgICAgICAgICAgICAgICAgIGNsX2RhdGEgKz0gKHJRW2NsX29mZnNldCArIDFdICYgMHg3ZikgPDwgNztcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChyUVtjbF9vZmZzZXQgKyAxXSAmIDB4ODApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIrKztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbF9kYXRhICs9IHJRW2NsX29mZnNldCArIDJdIDw8IDE0O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIC8vIGVuZCBpbmxpbmUgZ2V0VGlnaHRDTGVuZ3RoXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDEgKyBjbF9oZWFkZXIgKyBjbF9kYXRhO1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlRJR0hUIFwiICsgY21vZGUsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgICAgICAvLyBTaGlmdCBjdGwsIGNsZW5ndGggb2ZmXG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNoaWZ0Qnl0ZXMoMSArIGNsX2hlYWRlcik7XG5cbiAgICAgICAgICAgICAgICBpZiAocmF3KSB7XG4gICAgICAgICAgICAgICAgICAgIGRhdGEgPSB0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyhjbF9kYXRhKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBkYXRhID0gZGVjb21wcmVzcyh0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyhjbF9kYXRhKSwgdW5jb21wcmVzc2VkU2l6ZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5ibGl0UmdiSW1hZ2UodGhpcy5fRkJVLngsIHRoaXMuX0ZCVS55LCB0aGlzLl9GQlUud2lkdGgsIHRoaXMuX0ZCVS5oZWlnaHQsIGRhdGEsIDAsIGZhbHNlKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfS5iaW5kKHRoaXMpO1xuXG4gICAgICAgICAgICB2YXIgY3RsID0gdGhpcy5fc29jay5yUXBlZWs4KCk7XG5cbiAgICAgICAgICAgIC8vIEtlZXAgdGlnaHQgcmVzZXQgYml0c1xuICAgICAgICAgICAgcmVzZXRTdHJlYW1zID0gY3RsICYgMHhGO1xuXG4gICAgICAgICAgICAvLyBGaWd1cmUgb3V0IGZpbHRlclxuICAgICAgICAgICAgY3RsID0gY3RsID4+IDQ7XG4gICAgICAgICAgICBzdHJlYW1JZCA9IGN0bCAmIDB4MztcblxuICAgICAgICAgICAgaWYgKGN0bCA9PT0gMHgwOCkgICAgICAgY21vZGUgPSBcImZpbGxcIjtcbiAgICAgICAgICAgIGVsc2UgaWYgKGN0bCA9PT0gMHgwOSkgIGNtb2RlID0gXCJqcGVnXCI7XG4gICAgICAgICAgICBlbHNlIGlmIChjdGwgPT09IDB4MEEpICBjbW9kZSA9IFwicG5nXCI7XG4gICAgICAgICAgICBlbHNlIGlmIChjdGwgJiAweDA0KSAgICBjbW9kZSA9IFwiZmlsdGVyXCI7XG4gICAgICAgICAgICBlbHNlIGlmIChjdGwgPCAweDA0KSAgICBjbW9kZSA9IFwiY29weVwiO1xuICAgICAgICAgICAgZWxzZSByZXR1cm4gdGhpcy5fZmFpbChcIklsbGVnYWwgdGlnaHQgY29tcHJlc3Npb24gcmVjZWl2ZWQsIGN0bDogXCIgKyBjdGwpO1xuXG4gICAgICAgICAgICBpZiAoaXNUaWdodFBORyAmJiAoY21vZGUgPT09IFwiZmlsdGVyXCIgfHwgY21vZGUgPT09IFwiY29weVwiKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiZmlsdGVyL2NvcHkgcmVjZWl2ZWQgaW4gdGlnaHRQTkcgbW9kZVwiKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3dpdGNoIChjbW9kZSkge1xuICAgICAgICAgICAgICAgIC8vIGZpbGwgdXNlIGZiX2RlcHRoIGJlY2F1c2UgVFBJWEVMcyBkcm9wIHRoZSBwYWRkaW5nIGJ5dGVcbiAgICAgICAgICAgICAgICBjYXNlIFwiZmlsbFwiOiAgLy8gVFBJWEVMXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyArPSB0aGlzLl9mYl9kZXB0aDtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSBcImpwZWdcIjogIC8vIG1heCBjbGVuZ3RoXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyArPSAzO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIFwicG5nXCI6ICAvLyBtYXggY2xlbmd0aFxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgKz0gMztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSBcImZpbHRlclwiOiAgLy8gZmlsdGVyIGlkICsgbnVtIGNvbG9ycyBpZiBwYWxldHRlXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyArPSAyO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIFwiY29weVwiOlxuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiVElHSFQgXCIgKyBjbW9kZSwgdGhpcy5fRkJVLmJ5dGVzKSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgLy8gRGV0ZXJtaW5lIEZCVS5ieXRlc1xuICAgICAgICAgICAgc3dpdGNoIChjbW9kZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgXCJmaWxsXCI6XG4gICAgICAgICAgICAgICAgICAgIC8vIHNraXAgY3RsIGJ5dGVcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5maWxsUmVjdCh0aGlzLl9GQlUueCwgdGhpcy5fRkJVLnksIHRoaXMuX0ZCVS53aWR0aCwgdGhpcy5fRkJVLmhlaWdodCwgW3JRW3JRaSArIDNdLCByUVtyUWkgKyAyXSwgclFbclFpICsgMV1dLCBmYWxzZSk7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwQnl0ZXMoNCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgXCJwbmdcIjpcbiAgICAgICAgICAgICAgICBjYXNlIFwianBlZ1wiOlxuICAgICAgICAgICAgICAgICAgICAvLyBiZWdpbiBpbmxpbmUgZ2V0VGlnaHRDTGVuZ3RoIChyZXR1cm5pbmcgdHdvLWl0ZW0gYXJyYXlzIGlzIGZvciBwZWZvcm1hbmNlIHdpdGggR0MpXG4gICAgICAgICAgICAgICAgICAgIHZhciBjbF9vZmZzZXQgPSByUWkgKyAxO1xuICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIgPSAxO1xuICAgICAgICAgICAgICAgICAgICBjbF9kYXRhID0gMDtcbiAgICAgICAgICAgICAgICAgICAgY2xfZGF0YSArPSByUVtjbF9vZmZzZXRdICYgMHg3ZjtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJRW2NsX29mZnNldF0gJiAweDgwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIrKztcbiAgICAgICAgICAgICAgICAgICAgICAgIGNsX2RhdGEgKz0gKHJRW2NsX29mZnNldCArIDFdICYgMHg3ZikgPDwgNztcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChyUVtjbF9vZmZzZXQgKyAxXSAmIDB4ODApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIrKztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbF9kYXRhICs9IHJRW2NsX29mZnNldCArIDJdIDw8IDE0O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIC8vIGVuZCBpbmxpbmUgZ2V0VGlnaHRDTGVuZ3RoXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDEgKyBjbF9oZWFkZXIgKyBjbF9kYXRhOyAgLy8gY3RsICsgY2xlbmd0aCBzaXplICsganBlZy1kYXRhXG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlRJR0hUIFwiICsgY21vZGUsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy8gV2UgaGF2ZSBldmVyeXRoaW5nLCByZW5kZXIgaXRcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygxICsgY2xfaGVhZGVyKTsgIC8vIHNoaWZ0IG9mZiBjbHQgKyBjb21wYWN0IGxlbmd0aFxuICAgICAgICAgICAgICAgICAgICB2YXIgaW1nID0gbmV3IEltYWdlKCk7XG4gICAgICAgICAgICAgICAgICAgIGltZy5zcmMgPSBcImRhdGE6IGltYWdlL1wiICsgY21vZGUgK1xuICAgICAgICAgICAgICAgICAgICAgICAgUkZCLmV4dHJhY3RfZGF0YV91cmkodGhpcy5fc29jay5yUXNoaWZ0Qnl0ZXMoY2xfZGF0YSkpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LnJlbmRlclFfcHVzaCh7XG4gICAgICAgICAgICAgICAgICAgICAgICAndHlwZSc6ICdpbWcnLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ2ltZyc6IGltZyxcbiAgICAgICAgICAgICAgICAgICAgICAgICd4JzogdGhpcy5fRkJVLngsXG4gICAgICAgICAgICAgICAgICAgICAgICAneSc6IHRoaXMuX0ZCVS55XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICBpbWcgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIFwiZmlsdGVyXCI6XG4gICAgICAgICAgICAgICAgICAgIHZhciBmaWx0ZXJJZCA9IHJRW3JRaSArIDFdO1xuICAgICAgICAgICAgICAgICAgICBpZiAoZmlsdGVySWQgPT09IDEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghaGFuZGxlUGFsZXR0ZSgpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gRmlsdGVyIDAsIENvcHkgY291bGQgYmUgdmFsaWQgaGVyZSwgYnV0IHNlcnZlcnMgZG9uJ3Qgc2VuZCBpdCBhcyBhbiBleHBsaWNpdCBmaWx0ZXJcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIEZpbHRlciAyLCBHcmFkaWVudCBpcyB2YWxpZCBidXQgbm90IHVzZSBpZiBqcGVnIGlzIGVuYWJsZWRcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZhaWwoXCJVbnN1cHBvcnRlZCB0aWdodCBzdWJlbmNvZGluZyByZWNlaXZlZCwgZmlsdGVyOiBcIiArIGZpbHRlcklkKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIFwiY29weVwiOlxuICAgICAgICAgICAgICAgICAgICBpZiAoIWhhbmRsZUNvcHkoKSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG5cblxuICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gMDtcbiAgICAgICAgICAgIHRoaXMuX0ZCVS5yZWN0cy0tO1xuXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBUSUdIVDogZnVuY3Rpb24gKCkgeyByZXR1cm4gdGhpcy5fZW5jSGFuZGxlcnMuZGlzcGxheV90aWdodChmYWxzZSk7IH0sXG4gICAgICAgIFRJR0hUX1BORzogZnVuY3Rpb24gKCkgeyByZXR1cm4gdGhpcy5fZW5jSGFuZGxlcnMuZGlzcGxheV90aWdodCh0cnVlKTsgfSxcblxuICAgICAgICBsYXN0X3JlY3Q6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHRoaXMuX0ZCVS5yZWN0cyA9IDA7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBoYW5kbGVfRkJfcmVzaXplOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB0aGlzLl9mYl93aWR0aCA9IHRoaXMuX0ZCVS53aWR0aDtcbiAgICAgICAgICAgIHRoaXMuX2ZiX2hlaWdodCA9IHRoaXMuX0ZCVS5oZWlnaHQ7XG4gICAgICAgICAgICB0aGlzLl9kZXN0QnVmZiA9IG5ldyBVaW50OEFycmF5KHRoaXMuX2ZiX3dpZHRoICogdGhpcy5fZmJfaGVpZ2h0ICogNCk7XG4gICAgICAgICAgICB0aGlzLl9kaXNwbGF5LnJlc2l6ZSh0aGlzLl9mYl93aWR0aCwgdGhpcy5fZmJfaGVpZ2h0KTtcbiAgICAgICAgICAgIHRoaXMuX29uRkJSZXNpemUodGhpcywgdGhpcy5fZmJfd2lkdGgsIHRoaXMuX2ZiX2hlaWdodCk7XG4gICAgICAgICAgICB0aGlzLl90aW1pbmcuZmJ1X3J0X3N0YXJ0ID0gKG5ldyBEYXRlKCkpLmdldFRpbWUoKTtcbiAgICAgICAgICAgIHRoaXMuX3VwZGF0ZUNvbnRpbnVvdXNVcGRhdGVzKCk7XG5cbiAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDA7XG4gICAgICAgICAgICB0aGlzLl9GQlUucmVjdHMgLT0gMTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIEV4dGVuZGVkRGVza3RvcFNpemU6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDE7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJFeHRlbmRlZERlc2t0b3BTaXplXCIsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgIHRoaXMuX3N1cHBvcnRzU2V0RGVza3RvcFNpemUgPSB0cnVlO1xuICAgICAgICAgICAgdmFyIG51bWJlcl9vZl9zY3JlZW5zID0gdGhpcy5fc29jay5yUXBlZWs4KCk7XG5cbiAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDQgKyAobnVtYmVyX29mX3NjcmVlbnMgKiAxNik7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJFeHRlbmRlZERlc2t0b3BTaXplXCIsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwQnl0ZXMoMSk7ICAvLyBudW1iZXItb2Ytc2NyZWVuc1xuICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygzKTsgIC8vIHBhZGRpbmdcblxuICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBudW1iZXJfb2Zfc2NyZWVuczsgaSArPSAxKSB7XG4gICAgICAgICAgICAgICAgLy8gU2F2ZSB0aGUgaWQgYW5kIGZsYWdzIG9mIHRoZSBmaXJzdCBzY3JlZW5cbiAgICAgICAgICAgICAgICBpZiAoaSA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9zY3JlZW5faWQgPSB0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyg0KTsgICAgLy8gaWRcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygyKTsgICAgICAgICAgICAgICAgICAgICAgIC8vIHgtcG9zaXRpb25cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygyKTsgICAgICAgICAgICAgICAgICAgICAgIC8vIHktcG9zaXRpb25cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygyKTsgICAgICAgICAgICAgICAgICAgICAgIC8vIHdpZHRoXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwQnl0ZXMoMik7ICAgICAgICAgICAgICAgICAgICAgICAvLyBoZWlnaHRcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc2NyZWVuX2ZsYWdzID0gdGhpcy5fc29jay5yUXNoaWZ0Qnl0ZXMoNCk7IC8vIGZsYWdzXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygxNik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKlxuICAgICAgICAgICAgICogVGhlIHgtcG9zaXRpb24gaW5kaWNhdGVzIHRoZSByZWFzb24gZm9yIHRoZSBjaGFuZ2U6XG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogIDAgLSBzZXJ2ZXIgcmVzaXplZCBvbiBpdHMgb3duXG4gICAgICAgICAgICAgKiAgMSAtIHRoaXMgY2xpZW50IHJlcXVlc3RlZCB0aGUgcmVzaXplXG4gICAgICAgICAgICAgKiAgMiAtIGFub3RoZXIgY2xpZW50IHJlcXVlc3RlZCB0aGUgcmVzaXplXG4gICAgICAgICAgICAgKi9cblxuICAgICAgICAgICAgLy8gV2UgbmVlZCB0byBoYW5kbGUgZXJyb3JzIHdoZW4gd2UgcmVxdWVzdGVkIHRoZSByZXNpemUuXG4gICAgICAgICAgICBpZiAodGhpcy5fRkJVLnggPT09IDEgJiYgdGhpcy5fRkJVLnkgIT09IDApIHtcbiAgICAgICAgICAgICAgICB2YXIgbXNnID0gXCJcIjtcbiAgICAgICAgICAgICAgICAvLyBUaGUgeS1wb3NpdGlvbiBpbmRpY2F0ZXMgdGhlIHN0YXR1cyBjb2RlIGZyb20gdGhlIHNlcnZlclxuICAgICAgICAgICAgICAgIHN3aXRjaCAodGhpcy5fRkJVLnkpIHtcbiAgICAgICAgICAgICAgICBjYXNlIDE6XG4gICAgICAgICAgICAgICAgICAgIG1zZyA9IFwiUmVzaXplIGlzIGFkbWluaXN0cmF0aXZlbHkgcHJvaGliaXRlZFwiO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIDI6XG4gICAgICAgICAgICAgICAgICAgIG1zZyA9IFwiT3V0IG9mIHJlc291cmNlc1wiO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIDM6XG4gICAgICAgICAgICAgICAgICAgIG1zZyA9IFwiSW52YWxpZCBzY3JlZW4gbGF5b3V0XCI7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIG1zZyA9IFwiVW5rbm93biByZWFzb25cIjtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFV0aWwuSW5mbyhcIlNlcnZlciBkaWQgbm90IGFjY2VwdCB0aGUgcmVzaXplIHJlcXVlc3Q6IFwiICsgbXNnKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhpcy5fZW5jSGFuZGxlcnMuaGFuZGxlX0ZCX3Jlc2l6ZSgpO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgRGVza3RvcFNpemU6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHRoaXMuX2VuY0hhbmRsZXJzLmhhbmRsZV9GQl9yZXNpemUoKTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIEN1cnNvcjogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIj4+IHNldF9jdXJzb3JcIik7XG4gICAgICAgICAgICB2YXIgeCA9IHRoaXMuX0ZCVS54OyAgLy8gaG90c3BvdC14XG4gICAgICAgICAgICB2YXIgeSA9IHRoaXMuX0ZCVS55OyAgLy8gaG90c3BvdC15XG4gICAgICAgICAgICB2YXIgdyA9IHRoaXMuX0ZCVS53aWR0aDtcbiAgICAgICAgICAgIHZhciBoID0gdGhpcy5fRkJVLmhlaWdodDtcblxuICAgICAgICAgICAgdmFyIHBpeGVsc2xlbmd0aCA9IHcgKiBoICogdGhpcy5fZmJfQnBwO1xuICAgICAgICAgICAgdmFyIG1hc2tsZW5ndGggPSBNYXRoLmZsb29yKCh3ICsgNykgLyA4KSAqIGg7XG5cbiAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IHBpeGVsc2xlbmd0aCArIG1hc2tsZW5ndGg7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJjdXJzb3IgZW5jb2RpbmdcIiwgdGhpcy5fRkJVLmJ5dGVzKSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5jaGFuZ2VDdXJzb3IodGhpcy5fc29jay5yUXNoaWZ0Qnl0ZXMocGl4ZWxzbGVuZ3RoKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suclFzaGlmdEJ5dGVzKG1hc2tsZW5ndGgpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeCwgeSwgdywgaCk7XG5cbiAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDA7XG4gICAgICAgICAgICB0aGlzLl9GQlUucmVjdHMtLTtcblxuICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIjw8IHNldF9jdXJzb3JcIik7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBRRU1VRXh0ZW5kZWRLZXlFdmVudDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdGhpcy5fRkJVLnJlY3RzLS07XG5cbiAgICAgICAgICAgIHZhciBrZXlib2FyZEV2ZW50ID0gZG9jdW1lbnQuY3JlYXRlRXZlbnQoXCJrZXlib2FyZEV2ZW50XCIpO1xuICAgICAgICAgICAgaWYgKGtleWJvYXJkRXZlbnQuY29kZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fcWVtdUV4dEtleUV2ZW50U3VwcG9ydGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICB0aGlzLl9rZXlib2FyZC5zZXRRRU1VVk5DS2V5Ym9hcmRIYW5kbGVyKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgSlBFR19xdWFsaXR5X2xvOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBVdGlsLkVycm9yKFwiU2VydmVyIHNlbnQganBlZ19xdWFsaXR5IHBzZXVkby1lbmNvZGluZ1wiKTtcbiAgICAgICAgfSxcblxuICAgICAgICBjb21wcmVzc19sbzogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgVXRpbC5FcnJvcihcIlNlcnZlciBzZW50IGNvbXByZXNzIGxldmVsIHBzZXVkby1lbmNvZGluZ1wiKTtcbiAgICAgICAgfVxuICAgIH07XG59KSgpO1xuIl19