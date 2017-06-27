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
    //['JPEG_quality_med',      -26 ],
    //['JPEG_quality_hi',     -23 ],
    //['compress_lo',        -255 ],
    //['compress_hi',          -247 ],

    ['DesktopSize', -223], ['last_rect', -224], ['Cursor', -239], ['QEMUExtendedKeyEvent', -258], ['ExtendedDesktopSize', -308]
    //['xvp',                  -309 ], // None of these have actually been implemented. Advertising this to
    //['Fence',                -312 ], // a VNC server that supports these extensions results in immediate
    //['ContinuousUpdates',    -313 ]  // acknowledgement as pseudo-encoded rectangles and desyncing the client.
    ];

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

        _check_draw_completed: function () {
            if (this._display._renderQ.length == 0) {
                RFB.messages.fbUpdateRequests(this._sock, this._enabledContinuousUpdates, this._display.getCleanDirtyReset(), this._fb_width, this._fb_height);

                return;
            }
            requestAnimationFrame(this._check_draw_completed.bind(this));
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
                        this._check_draw_completed();
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInJmYi5qcyJdLCJuYW1lcyI6WyJSRkIiLCJkZWZhdWx0cyIsIl9yZmJfaG9zdCIsIl9yZmJfcG9ydCIsIl9yZmJfcGFzc3dvcmQiLCJfcmZiX3BhdGgiLCJfcmZiX3N0YXRlIiwiX3JmYl92ZXJzaW9uIiwiX3JmYl9tYXhfdmVyc2lvbiIsIl9yZmJfYXV0aF9zY2hlbWUiLCJfcmZiX3RpZ2h0dm5jIiwiX3JmYl94dnBfdmVyIiwiX2VuY29kaW5ncyIsIl9lbmNIYW5kbGVycyIsIl9lbmNOYW1lcyIsIl9lbmNTdGF0cyIsIl9zb2NrIiwiX2Rpc3BsYXkiLCJfa2V5Ym9hcmQiLCJfbW91c2UiLCJfZGlzY29ublRpbWVyIiwiX21zZ1RpbWVyIiwiX3N1cHBvcnRzRmVuY2UiLCJfc3VwcG9ydHNDb250aW51b3VzVXBkYXRlcyIsIl9lbmFibGVkQ29udGludW91c1VwZGF0ZXMiLCJfRkJVIiwicmVjdHMiLCJzdWJyZWN0cyIsImxpbmVzIiwidGlsZXMiLCJieXRlcyIsIngiLCJ5Iiwid2lkdGgiLCJoZWlnaHQiLCJlbmNvZGluZyIsInN1YmVuY29kaW5nIiwiYmFja2dyb3VuZCIsInpsaWIiLCJfZmJfQnBwIiwiX2ZiX2RlcHRoIiwiX2ZiX3dpZHRoIiwiX2ZiX2hlaWdodCIsIl9mYl9uYW1lIiwiX2Rlc3RCdWZmIiwiX3BhbGV0dGVCdWZmIiwiVWludDhBcnJheSIsIl9ycmVfY2h1bmtfc3oiLCJfdGltaW5nIiwibGFzdF9mYnUiLCJmYnVfdG90YWwiLCJmYnVfdG90YWxfY250IiwiZnVsbF9mYnVfdG90YWwiLCJmdWxsX2ZidV9jbnQiLCJmYnVfcnRfc3RhcnQiLCJmYnVfcnRfdG90YWwiLCJmYnVfcnRfY250IiwicGl4ZWxzIiwiX3N1cHBvcnRzU2V0RGVza3RvcFNpemUiLCJfc2NyZWVuX2lkIiwiX3NjcmVlbl9mbGFncyIsIl9tb3VzZV9idXR0b25NYXNrIiwiX21vdXNlX2FyciIsIl92aWV3cG9ydERyYWdnaW5nIiwiX3ZpZXdwb3J0RHJhZ1BvcyIsIl92aWV3cG9ydEhhc01vdmVkIiwiX3FlbXVFeHRLZXlFdmVudFN1cHBvcnRlZCIsInNldF9kZWZhdWx0cyIsImRvY3VtZW50IiwiRGVidWciLCJPYmplY3QiLCJrZXlzIiwiZW5jb2RpbmdIYW5kbGVycyIsImZvckVhY2giLCJlbmNOYW1lIiwiYmluZCIsImkiLCJsZW5ndGgiLCJ0YXJnZXQiLCJfdGFyZ2V0IiwiZXhjIiwiRXJyb3IiLCJfZm9jdXNDb250YWluZXIiLCJvbktleVByZXNzIiwiX2hhbmRsZUtleVByZXNzIiwib25Nb3VzZUJ1dHRvbiIsIl9oYW5kbGVNb3VzZUJ1dHRvbiIsIm9uTW91c2VNb3ZlIiwiX2hhbmRsZU1vdXNlTW92ZSIsIm5vdGlmeSIsInN5bmMiLCJvbiIsIl9oYW5kbGVfbWVzc2FnZSIsIl91cGRhdGVTdGF0ZSIsIl9mYWlsIiwiZSIsIldhcm4iLCJtc2ciLCJjb2RlIiwicmVhc29uIiwib2ZmIiwiX2luaXRfdmFycyIsInJtb2RlIiwiZ2V0X3JlbmRlcl9tb2RlIiwiSW5mbyIsInByb3RvdHlwZSIsImNvbm5lY3QiLCJob3N0IiwicG9ydCIsInBhc3N3b3JkIiwicGF0aCIsInVuZGVmaW5lZCIsImRpc2Nvbm5lY3QiLCJzZW5kUGFzc3dvcmQiLCJwYXNzd2QiLCJzZXRUaW1lb3V0IiwiX2luaXRfbXNnIiwic2VuZEN0cmxBbHREZWwiLCJfdmlld19vbmx5IiwibWVzc2FnZXMiLCJrZXlFdmVudCIsIlhLX0NvbnRyb2xfTCIsIlhLX0FsdF9MIiwiWEtfRGVsZXRlIiwieHZwT3AiLCJ2ZXIiLCJvcCIsInNlbmRfc3RyaW5nIiwiU3RyaW5nIiwiZnJvbUNoYXJDb2RlIiwieHZwU2h1dGRvd24iLCJ4dnBSZWJvb3QiLCJ4dnBSZXNldCIsInNlbmRLZXkiLCJkb3duIiwiY2xpcGJvYXJkUGFzdGVGcm9tIiwidGV4dCIsImNsaWVudEN1dFRleHQiLCJyZXF1ZXN0RGVza3RvcFNpemUiLCJzZXREZXNrdG9wU2l6ZSIsImZsdXNoIiwiX2Nvbm5lY3QiLCJ1cmkiLCJVc2luZ1NvY2tldElPIiwiX2VuY3J5cHQiLCJvcGVuIiwiX3dzUHJvdG9jb2xzIiwiemxpYnMiLCJJbmZsYXRlIiwiX3ByaW50X3N0YXRzIiwicyIsIl9jbGVhbnVwU29ja2V0Iiwic3RhdGUiLCJjbGVhckludGVydmFsIiwiZ2V0X2NvbnRleHQiLCJ1bmdyYWIiLCJkZWZhdWx0Q3Vyc29yIiwiZ2V0X2xvZ2dpbmciLCJjbGVhciIsImNsb3NlIiwic3RhdHVzTXNnIiwib2xkc3RhdGUiLCJjbXNnIiwiZnVsbG1zZyIsImNsZWFyVGltZW91dCIsIl9kaXNjb25uZWN0VGltZW91dCIsIl9vblVwZGF0ZVN0YXRlIiwiclFsZW4iLCJfbm9ybWFsX21zZyIsImtleWV2ZW50IiwidHlwZSIsInNjYW5jb2RlIiwia2V5c3ltIiwiUUVNVUV4dGVuZGVkS2V5RXZlbnQiLCJibWFzayIsIl92aWV3cG9ydERyYWciLCJwb2ludGVyRXZlbnQiLCJhYnNYIiwiYWJzWSIsImRlbHRhWCIsImRlbHRhWSIsImRyYWdUaHJlc2hvbGQiLCJ3aW5kb3ciLCJkZXZpY2VQaXhlbFJhdGlvIiwiTWF0aCIsImFicyIsInZpZXdwb3J0Q2hhbmdlUG9zIiwiX25lZ290aWF0ZV9wcm90b2NvbF92ZXJzaW9uIiwic3ZlcnNpb24iLCJyUXNoaWZ0U3RyIiwic3Vic3RyIiwiaXNfcmVwZWF0ZXIiLCJyZXBlYXRlcklEIiwiX3JlcGVhdGVySUQiLCJjdmVyc2lvbiIsInBhcnNlSW50IiwiX25lZ290aWF0ZV9zZWN1cml0eSIsIm51bV90eXBlcyIsInJRc2hpZnQ4IiwiclF3YWl0Iiwic3RybGVuIiwiclFzaGlmdDMyIiwidHlwZXMiLCJyUXNoaWZ0Qnl0ZXMiLCJzZW5kIiwiX25lZ290aWF0ZV94dnBfYXV0aCIsInh2cF9zZXAiLCJfeHZwX3Bhc3N3b3JkX3NlcCIsInh2cF9hdXRoIiwic3BsaXQiLCJfb25QYXNzd29yZFJlcXVpcmVkIiwieHZwX2F1dGhfc3RyIiwic2xpY2UiLCJqb2luIiwiX25lZ290aWF0ZV9hdXRoZW50aWNhdGlvbiIsIl9uZWdvdGlhdGVfc3RkX3ZuY19hdXRoIiwiY2hhbGxlbmdlIiwiQXJyYXkiLCJjYWxsIiwicmVzcG9uc2UiLCJnZW5ERVMiLCJfbmVnb3RpYXRlX3RpZ2h0X3R1bm5lbHMiLCJudW1UdW5uZWxzIiwiY2xpZW50U3VwcG9ydGVkVHVubmVsVHlwZXMiLCJ2ZW5kb3IiLCJzaWduYXR1cmUiLCJzZXJ2ZXJTdXBwb3J0ZWRUdW5uZWxUeXBlcyIsImNhcF9jb2RlIiwiY2FwX3ZlbmRvciIsImNhcF9zaWduYXR1cmUiLCJfbmVnb3RpYXRlX3RpZ2h0X2F1dGgiLCJzdWJBdXRoQ291bnQiLCJjbGllbnRTdXBwb3J0ZWRUeXBlcyIsInNlcnZlclN1cHBvcnRlZFR5cGVzIiwiY2FwTnVtIiwiY2FwYWJpbGl0aWVzIiwicHVzaCIsImF1dGhUeXBlIiwiaW5kZXhPZiIsIl9oYW5kbGVfc2VjdXJpdHlfcmVzdWx0IiwiX25lZ290aWF0ZV9zZXJ2ZXJfaW5pdCIsInJRc2hpZnQxNiIsImJwcCIsImRlcHRoIiwiYmlnX2VuZGlhbiIsInRydWVfY29sb3IiLCJyZWRfbWF4IiwiZ3JlZW5fbWF4IiwiYmx1ZV9tYXgiLCJyZWRfc2hpZnQiLCJncmVlbl9zaGlmdCIsImJsdWVfc2hpZnQiLCJyUXNraXBCeXRlcyIsIm5hbWVfbGVuZ3RoIiwiZGVjb2RlVVRGOCIsIm51bVNlcnZlck1lc3NhZ2VzIiwibnVtQ2xpZW50TWVzc2FnZXMiLCJudW1FbmNvZGluZ3MiLCJ0b3RhbE1lc3NhZ2VzTGVuZ3RoIiwiX29uRGVza3RvcE5hbWUiLCJfdHJ1ZV9jb2xvciIsInNldF90cnVlX2NvbG9yIiwicmVzaXplIiwiX29uRkJSZXNpemUiLCJncmFiIiwicGl4ZWxGb3JtYXQiLCJjbGllbnRFbmNvZGluZ3MiLCJfbG9jYWxfY3Vyc29yIiwiZmJVcGRhdGVSZXF1ZXN0cyIsImdldENsZWFuRGlydHlSZXNldCIsIkRhdGUiLCJnZXRUaW1lIiwiX3NoYXJlZCIsIl9oYW5kbGVfc2V0X2NvbG91cl9tYXBfbXNnIiwiclFza2lwOCIsImZpcnN0X2NvbG91ciIsIm51bV9jb2xvdXJzIiwiYyIsInJlZCIsImdyZWVuIiwiYmx1ZSIsInNldF9jb2xvdXJNYXAiLCJnZXRfY29sb3VyTWFwIiwiX2hhbmRsZV9zZXJ2ZXJfY3V0X3RleHQiLCJfb25DbGlwYm9hcmQiLCJfaGFuZGxlX3NlcnZlcl9mZW5jZV9tc2ciLCJmbGFncyIsInBheWxvYWQiLCJjbGllbnRGZW5jZSIsIl9oYW5kbGVfeHZwX21zZyIsInh2cF92ZXIiLCJ4dnBfbXNnIiwiX29uWHZwSW5pdCIsIl9jaGVja19kcmF3X2NvbXBsZXRlZCIsIl9yZW5kZXJRIiwicmVxdWVzdEFuaW1hdGlvbkZyYW1lIiwibXNnX3R5cGUiLCJyZXQiLCJfZnJhbWVidWZmZXJVcGRhdGUiLCJfb25CZWxsIiwiZmlyc3QiLCJfdXBkYXRlQ29udGludW91c1VwZGF0ZXMiLCJyUXNsaWNlIiwibm93IiwiY3VyX2ZidSIsImhkciIsIl9vbkZCVVJlY2VpdmUiLCJmYnVfcnRfZGlmZiIsIl9vbkZCVUNvbXBsZXRlIiwiZW5hYmxlQ29udGludW91c1VwZGF0ZXMiLCJtYWtlX3Byb3BlcnRpZXMiLCJzZXRfbG9jYWxfY3Vyc29yIiwiY3Vyc29yIiwiZGlzYWJsZUxvY2FsQ3Vyc29yIiwiZ2V0X2N1cnNvcl91cmkiLCJnZXRfZGlzcGxheSIsImdldF9rZXlib2FyZCIsImdldF9tb3VzZSIsInNvY2siLCJidWZmIiwiX3NRIiwib2Zmc2V0IiwiX3NRbGVuIiwia2V5Y29kZSIsImdldFJGQmtleWNvZGUiLCJ4dF9zY2FuY29kZSIsInVwcGVyQnl0ZSIsImxvd2VyQnl0ZSIsIlJGQmtleWNvZGUiLCJtYXNrIiwibiIsImNoYXJDb2RlQXQiLCJpZCIsImVuYWJsZSIsImVuY29kaW5ncyIsImxvY2FsX2N1cnNvciIsImoiLCJjbnQiLCJlbmMiLCJvbmx5Tm9uSW5jIiwiY2xlYW5EaXJ0eSIsImZiX3dpZHRoIiwiZmJfaGVpZ2h0Iiwib2Zmc2V0SW5jcmVtZW50IiwiY2IiLCJjbGVhbkJveCIsInciLCJoIiwiZmJVcGRhdGVSZXF1ZXN0IiwiZGlydHlCb3hlcyIsImRiIiwiaW5jcmVtZW50YWwiLCJlbmNyeXB0IiwiZXh0cmFjdF9kYXRhX3VyaSIsImFyciIsImVuY29kZSIsIlJBVyIsImN1cl95IiwiY3Vycl9oZWlnaHQiLCJtaW4iLCJmbG9vciIsImJsaXRJbWFnZSIsImdldF9yUSIsImdldF9yUWkiLCJDT1BZUkVDVCIsImNvcHlJbWFnZSIsIlJSRSIsImNvbG9yIiwiZmlsbFJlY3QiLCJjaHVuayIsIkhFWFRJTEUiLCJyUSIsInJRaSIsInRpbGVzX3giLCJjZWlsIiwidGlsZXNfeSIsInRvdGFsX3RpbGVzIiwiY3Vycl90aWxlIiwidGlsZV94IiwidGlsZV95IiwibGFzdHN1YmVuY29kaW5nIiwiZm9yZWdyb3VuZCIsInN0YXJ0VGlsZSIsInh5Iiwic3giLCJzeSIsIndoIiwic3ciLCJzaCIsInN1YlRpbGUiLCJmaW5pc2hUaWxlIiwic2V0X3JRaSIsImdldFRpZ2h0Q0xlbmd0aCIsImhlYWRlciIsImRhdGEiLCJkaXNwbGF5X3RpZ2h0IiwiaXNUaWdodFBORyIsImNoZWNrc3VtIiwic3VtIiwicmVzZXRTdHJlYW1zIiwic3RyZWFtSWQiLCJkZWNvbXByZXNzIiwiZXhwZWN0ZWQiLCJyZXNldCIsInVuY29tcHJlc3NlZCIsImluZmxhdGUiLCJpbmRleGVkVG9SR0JYMkNvbG9yIiwicGFsZXR0ZSIsImRlc3QiLCJ3MSIsImIiLCJkcCIsInNwIiwiaW5kZXhlZFRvUkdCWCIsInRvdGFsIiwiclF3aG9sZSIsImNtb2RlIiwiY2xfaGVhZGVyIiwiY2xfZGF0YSIsImhhbmRsZVBhbGV0dGUiLCJudW1Db2xvcnMiLCJwYWxldHRlU2l6ZSIsInJvd1NpemUiLCJyYXciLCJjbF9vZmZzZXQiLCJyUXNoaWZ0VG8iLCJyZ2J4IiwiYmxpdFJnYnhJbWFnZSIsImhhbmRsZUNvcHkiLCJ1bmNvbXByZXNzZWRTaXplIiwiYmxpdFJnYkltYWdlIiwiY3RsIiwiclFwZWVrOCIsImltZyIsIkltYWdlIiwic3JjIiwicmVuZGVyUV9wdXNoIiwiZmlsdGVySWQiLCJUSUdIVCIsIlRJR0hUX1BORyIsImxhc3RfcmVjdCIsImhhbmRsZV9GQl9yZXNpemUiLCJFeHRlbmRlZERlc2t0b3BTaXplIiwibnVtYmVyX29mX3NjcmVlbnMiLCJEZXNrdG9wU2l6ZSIsIkN1cnNvciIsInBpeGVsc2xlbmd0aCIsIm1hc2tsZW5ndGgiLCJjaGFuZ2VDdXJzb3IiLCJrZXlib2FyZEV2ZW50IiwiY3JlYXRlRXZlbnQiLCJzZXRRRU1VVk5DS2V5Ym9hcmRIYW5kbGVyIiwiSlBFR19xdWFsaXR5X2xvIiwiY29tcHJlc3NfbG8iXSwibWFwcGluZ3MiOiI7Ozs7O2tCQXlCd0JBLEc7O0FBYnhCOzs7O0FBQ0E7Ozs7QUFDQTs7QUFDQTs7OztBQUNBOzs7O0FBQ0E7Ozs7QUFDQTs7OztBQUNBOzs7O0FBQ0E7Ozs7OztBQUVBO0FBQ0E7O0FBRWUsU0FBU0EsR0FBVCxDQUFhQyxRQUFiLEVBQXVCO0FBQ2xDOztBQUNBLFFBQUksQ0FBQ0EsUUFBTCxFQUFlO0FBQ1hBLG1CQUFXLEVBQVg7QUFDSDs7QUFFRCxTQUFLQyxTQUFMLEdBQWlCLEVBQWpCO0FBQ0EsU0FBS0MsU0FBTCxHQUFpQixJQUFqQjtBQUNBLFNBQUtDLGFBQUwsR0FBcUIsRUFBckI7QUFDQSxTQUFLQyxTQUFMLEdBQWlCLEVBQWpCOztBQUVBLFNBQUtDLFVBQUwsR0FBa0IsY0FBbEI7QUFDQSxTQUFLQyxZQUFMLEdBQW9CLENBQXBCO0FBQ0EsU0FBS0MsZ0JBQUwsR0FBd0IsR0FBeEI7QUFDQSxTQUFLQyxnQkFBTCxHQUF3QixFQUF4Qjs7QUFFQSxTQUFLQyxhQUFMLEdBQXFCLEtBQXJCO0FBQ0EsU0FBS0MsWUFBTCxHQUFvQixDQUFwQjs7QUFFQTtBQUNBLFNBQUtDLFVBQUwsR0FBa0IsQ0FDZCxDQUFDLFVBQUQsRUFBeUIsSUFBekIsQ0FEYyxFQUVkLENBQUMsT0FBRCxFQUF5QixJQUF6QixDQUZjLEVBR2QsQ0FBQyxXQUFELEVBQXlCLENBQUMsR0FBMUIsQ0FIYyxFQUlkLENBQUMsU0FBRCxFQUF5QixJQUF6QixDQUpjLEVB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QUVvQ0MsQ0FGcEM7O0FBSUEsaUJBQUtsVSxJQUFMLENBQVVLLEtBQVYsR0FBa0IsQ0FBbEI7QUFDQSxpQkFBS0wsSUFBTCxDQUFVQyxLQUFWOztBQUVBLDJCQUFLMkMsS0FBTCxDQUFXLGVBQVg7QUFDQSxtQkFBTyxJQUFQO0FBQ0gsU0Fyb0JrQjs7QUF1b0JuQndHLDhCQUFzQixZQUFZO0FBQzlCLGlCQUFLcEosSUFBTCxDQUFVQyxLQUFWOztBQUVBLGdCQUFJdWEsZ0JBQWdCN1gsU0FBUzhYLFdBQVQsQ0FBcUIsZUFBckIsQ0FBcEI7QUFDQSxnQkFBSUQsY0FBYy9WLElBQWQsS0FBdUJhLFNBQTNCLEVBQXNDO0FBQ2xDLHFCQUFLN0MseUJBQUwsR0FBaUMsSUFBakM7QUFDQSxxQkFBS2hELFNBQUwsQ0FBZWliLHlCQUFmO0FBQ0g7QUFDSixTQS9vQmtCOztBQWlwQm5CQyx5QkFBaUIsWUFBWTtBQUN6QiwyQkFBS25YLEtBQUwsQ0FBVywwQ0FBWDtBQUNILFNBbnBCa0I7O0FBcXBCbkJvWCxxQkFBYSxZQUFZO0FBQ3JCLDJCQUFLcFgsS0FBTCxDQUFXLDRDQUFYO0FBQ0g7QUF2cEJrQixLQUF2QjtBQXlwQkgsQ0FwakVEIiwiZmlsZSI6InJmYi5qcyIsInNvdXJjZXNDb250ZW50IjpbIi8qXG4gKiBub1ZOQzogSFRNTDUgVk5DIGNsaWVudFxuICogQ29weXJpZ2h0IChDKSAyMDEyIEpvZWwgTWFydGluXG4gKiBDb3B5cmlnaHQgKEMpIDIwMTYgU2FtdWVsIE1hbm5laGVkIGZvciBDZW5kaW8gQUJcbiAqIExpY2Vuc2VkIHVuZGVyIE1QTCAyLjAgKHNlZSBMSUNFTlNFLnR4dClcbiAqXG4gKiBTZWUgUkVBRE1FLm1kIGZvciB1c2FnZSBhbmQgaW50ZWdyYXRpb24gaW5zdHJ1Y3Rpb25zLlxuICpcbiAqIFRJR0hUIGRlY29kZXIgcG9ydGlvbjpcbiAqIChjKSAyMDEyIE1pY2hhZWwgVGluZ2xvZiwgSm9lIEJhbGF6LCBMZXMgUGllY2ggKE1lcmN1cmkuY2EpXG4gKi9cblxuaW1wb3J0IFV0aWwgZnJvbSBcIi4vdXRpbFwiO1xuaW1wb3J0IERpc3BsYXkgZnJvbSBcIi4vZGlzcGxheVwiO1xuaW1wb3J0IHsgS2V5Ym9hcmQsIE1vdXNlIH0gZnJvbSBcIi4vaW5wdXQvZGV2aWNlc1wiXG5pbXBvcnQgV2Vic29jayBmcm9tIFwiLi93ZWJzb2NrXCJcbmltcG9ydCBCYXNlNjQgZnJvbSBcIi4vYmFzZTY0XCI7XG5pbXBvcnQgREVTIGZyb20gXCIuL2Rlc1wiO1xuaW1wb3J0IEtleVRhYmxlIGZyb20gXCIuL2lucHV0L2tleXN5bVwiO1xuaW1wb3J0IFh0U2NhbmNvZGUgZnJvbSBcIi4vaW5wdXQveHRzY2FuY29kZXNcIjtcbmltcG9ydCBJbmZsYXRvciBmcm9tIFwiLi9pbmZsYXRvci5tb2RcIjtcblxuLypqc2xpbnQgd2hpdGU6IGZhbHNlLCBicm93c2VyOiB0cnVlICovXG4vKmdsb2JhbCB3aW5kb3csIFV0aWwsIERpc3BsYXksIEtleWJvYXJkLCBNb3VzZSwgV2Vic29jaywgV2Vic29ja19uYXRpdmUsIEJhc2U2NCwgREVTLCBLZXlUYWJsZSwgSW5mbGF0b3IsIFh0U2NhbmNvZGUgKi9cblxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gUkZCKGRlZmF1bHRzKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG4gICAgaWYgKCFkZWZhdWx0cykge1xuICAgICAgICBkZWZhdWx0cyA9IHt9O1xuICAgIH1cblxuICAgIHRoaXMuX3JmYl9ob3N0ID0gJyc7XG4gICAgdGhpcy5fcmZiX3BvcnQgPSA1OTAwO1xuICAgIHRoaXMuX3JmYl9wYXNzd29yZCA9ICcnO1xuICAgIHRoaXMuX3JmYl9wYXRoID0gJyc7XG5cbiAgICB0aGlzLl9yZmJfc3RhdGUgPSAnZGlzY29ubmVjdGVkJztcbiAgICB0aGlzLl9yZmJfdmVyc2lvbiA9IDA7XG4gICAgdGhpcy5fcmZiX21heF92ZXJzaW9uID0gMy44O1xuICAgIHRoaXMuX3JmYl9hdXRoX3NjaGVtZSA9ICcnO1xuXG4gICAgdGhpcy5fcmZiX3RpZ2h0dm5jID0gZmFsc2U7XG4gICAgdGhpcy5fcmZiX3h2cF92ZXIgPSAwO1xuXG4gICAgLy8gSW4gcHJlZmVyZW5jZSBvcmRlclxuICAgIHRoaXMuX2VuY29kaW5ncyA9IFtcbiAgICAgICAgWydDT1BZUkVDVCcsICAgICAgICAgICAgIDB4MDEgXSxcbiAgICAgICAgWydUSUdIVCcsICAgICAgICAgICAgICAgIDB4MDcgXSxcbiAgICAgICAgWydUSUdIVF9QTkcnLCAgICAgICAgICAgIC0yNjAgXSxcbiAgICAgICAgWydIRVhUSUxFJywgICAgICAgICAgICAgIDB4MDUgXSxcbiAgICAgICAgWydSUkUnLCAgICAgICAgICAgICAgICAgIDB4MDIgXSxcbiAgICAgICAgWydSQVcnLCAgICAgICAgICAgICAgICAgIDB4MDAgXSxcblxuICAgICAgICAvLyBQc3VlZG8tZW5jb2Rpbmcgc2V0dGluZ3NcblxuICAgICAgICAvL1snSlBFR19xdWFsaXR5X2xvJywgICAgIC0zMiBdLFxuICAgICAgICAvL1snSlBFR19xdWFsaXR5X21lZCcsICAgICAgLTI2IF0sXG4gICAgICAgIC8vWydKUEVHX3F1YWxpdHlfaGknLCAgICAgLTIzIF0sXG4gICAgICAgIC8vWydjb21wcmVzc19sbycsICAgICAgICAtMjU1IF0sXG4gICAgICAgIC8vWydjb21wcmVzc19oaScsICAgICAgICAgIC0yNDcgXSxcblxuICAgICAgICBbJ0Rlc2t0b3BTaXplJywgICAgICAgICAgLTIyMyBdLFxuICAgICAgICBbJ2xhc3RfcmVjdCcsICAgICAgICAgICAgLTIyNCBdLFxuICAgICAgICBbJ0N1cnNvcicsICAgICAgICAgICAgICAgLTIzOSBdLFxuICAgICAgICBbJ1FFTVVFeHRlbmRlZEtleUV2ZW50JywgLTI1OCBdLFxuICAgICAgICBbJ0V4dGVuZGVkRGVza3RvcFNpemUnLCAgLTMwOCBdXG4gICAgICAgIC8vWyd4dnAnLCAgICAgICAgICAgICAgICAgIC0zMDkgXSwgLy8gTm9uZSBvZiB0aGVzZSBoYXZlIGFjdHVhbGx5IGJlZW4gaW1wbGVtZW50ZWQuIEFkdmVydGlzaW5nIHRoaXMgdG9cbiAgICAgICAgLy9bJ0ZlbmNlJywgICAgICAgICAgICAgICAgLTMxMiBdLCAvLyBhIFZOQyBzZXJ2ZXIgdGhhdCBzdXBwb3J0cyB0aGVzZSBleHRlbnNpb25zIHJlc3VsdHMgaW4gaW1tZWRpYXRlXG4gICAgICAgIC8vWydDb250aW51b3VzVXBkYXRlcycsICAgIC0zMTMgXSAgLy8gYWNrbm93bGVkZ2VtZW50IGFzIHBzZXVkby1lbmNvZGVkIHJlY3RhbmdsZXMgYW5kIGRlc3luY2luZyB0aGUgY2xpZW50LlxuICAgIF07XG5cbiAgICB0aGlzLl9lbmNIYW5kbGVycyA9IHt9O1xuICAgIHRoaXMuX2VuY05hbWVzID0ge307XG4gICAgdGhpcy5fZW5jU3RhdHMgPSB7fTtcblxuICAgIHRoaXMuX3NvY2sgPSBudWxsOyAgICAgICAgICAgICAgLy8gV2Vic29jayBvYmplY3RcbiAgICB0aGlzLl9kaXNwbGF5ID0gbnVsbDsgICAgICAgICAgIC8vIERpc3BsYXkgb2JqZWN0XG4gICAgdGhpcy5fa2V5Ym9hcmQgPSBudWxsOyAgICAgICAgICAvLyBLZXlib2FyZCBpbnB1dCBoYW5kbGVyIG9iamVjdFxuICAgIHRoaXMuX21vdXNlID0gbnVsbDsgICAgICAgICAgICAgLy8gTW91c2UgaW5wdXQgaGFuZGxlciBvYmplY3RcbiAgICB0aGlzLl9kaXNjb25uVGltZXIgPSBudWxsOyAgICAgIC8vIGRpc2Nvbm5lY3Rpb24gdGltZXJcbiAgICB0aGlzLl9tc2dUaW1lciA9IG51bGw7ICAgICAgICAgIC8vIHF1ZXVlZCBoYW5kbGVfbXNnIHRpbWVyXG5cbiAgICB0aGlzLl9zdXBwb3J0c0ZlbmNlID0gZmFsc2U7XG5cbiAgICB0aGlzLl9zdXBwb3J0c0NvbnRpbnVvdXNVcGRhdGVzID0gZmFsc2U7XG4gICAgdGhpcy5fZW5hYmxlZENvbnRpbnVvdXNVcGRhdGVzID0gZmFsc2U7XG5cbiAgICAvLyBGcmFtZSBidWZmZXIgdXBkYXRlIHN0YXRlXG4gICAgdGhpcy5fRkJVID0ge1xuICAgICAgICByZWN0czogMCxcbiAgICAgICAgc3VicmVjdHM6IDAsICAgICAgICAgICAgLy8gUlJFXG4gICAgICAgIGxpbmVzOiAwLCAgICAgICAgICAgICAgIC8vIFJBV1xuICAgICAgICB0aWxlczogMCwgICAgICAgICAgICAgICAvLyBIRVhUSUxFXG4gICAgICAgIGJ5dGVzOiAwLFxuICAgICAgICB4OiAwLFxuICAgICAgICB5OiAwLFxuICAgICAgICB3aWR0aDogMCxcbiAgICAgICAgaGVpZ2h0OiAwLFxuICAgICAgICBlbmNvZGluZzogMCxcbiAgICAgICAgc3ViZW5jb2Rpbmc6IC0xLFxuICAgICAgICBiYWNrZ3JvdW5kOiBudWxsLFxuICAgICAgICB6bGliOiBbXSAgICAgICAgICAgICAgICAvLyBUSUdIVCB6bGliIHN0cmVhbXNcbiAgICB9O1xuXG4gICAgdGhpcy5fZmJfQnBwID0gNDtcbiAgICB0aGlzLl9mYl9kZXB0aCA9IDM7XG4gICAgdGhpcy5fZmJfd2lkdGggPSAwO1xuICAgIHRoaXMuX2ZiX2hlaWdodCA9IDA7XG4gICAgdGhpcy5fZmJfbmFtZSA9IFwiXCI7XG5cbiAgICB0aGlzLl9kZXN0QnVmZiA9IG51bGw7XG4gICAgdGhpcy5fcGFsZXR0ZUJ1ZmYgPSBuZXcgVWludDhBcnJheSgxMDI0KTsgIC8vIDI1NiAqIDQgKG1heCBwYWxldHRlIHNpemUgKiBtYXggYnl0ZXMtcGVyLXBpeGVsKVxuXG4gICAgdGhpcy5fcnJlX2NodW5rX3N6ID0gMTAwO1xuXG4gICAgdGhpcy5fdGltaW5nID0ge1xuICAgICAgICBsYXN0X2ZidTogMCxcbiAgICAgICAgZmJ1X3RvdGFsOiAwLFxuICAgICAgICBmYnVfdG90YWxfY250OiAwLFxuICAgICAgICBmdWxsX2ZidV90b3RhbDogMCxcbiAgICAgICAgZnVsbF9mYnVfY250OiAwLFxuXG4gICAgICAgIGZidV9ydF9zdGFydDogMCxcbiAgICAgICAgZmJ1X3J0X3RvdGFsOiAwLFxuICAgICAgICBmYnVfcnRfY250OiAwLFxuICAgICAgICBwaXhlbHM6IDBcbiAgICB9O1xuXG4gICAgdGhpcy5fc3VwcG9ydHNTZXREZXNrdG9wU2l6ZSA9IGZhbHNlO1xuICAgIHRoaXMuX3NjcmVlbl9pZCA9IDA7XG4gICAgdGhpcy5fc2NyZWVuX2ZsYWdzID0gMDtcblxuICAgIC8vIE1vdXNlIHN0YXRlXG4gICAgdGhpcy5fbW91c2VfYnV0dG9uTWFzayA9IDA7XG4gICAgdGhpcy5fbW91c2VfYXJyID0gW107XG4gICAgdGhpcy5fdmlld3BvcnREcmFnZ2luZyA9IGZhbHNlO1xuICAgIHRoaXMuX3ZpZXdwb3J0RHJhZ1BvcyA9IHt9O1xuICAgIHRoaXMuX3ZpZXdwb3J0SGFzTW92ZWQgPSBmYWxzZTtcblxuICAgIC8vIFFFTVUgRXh0ZW5kZWQgS2V5IEV2ZW50IHN1cHBvcnQgLSBkZWZhdWx0IHRvIGZhbHNlXG4gICAgdGhpcy5fcWVtdUV4dEtleUV2ZW50U3VwcG9ydGVkID0gZmFsc2U7XG5cbiAgICAvLyBzZXQgdGhlIGRlZmF1bHQgdmFsdWUgb24gdXNlci1mYWNpbmcgcHJvcGVydGllc1xuICAgIFV0aWwuc2V0X2RlZmF1bHRzKHRoaXMsIGRlZmF1bHRzLCB7XG4gICAgICAgICd0YXJnZXQnOiAnbnVsbCcsICAgICAgICAgICAgICAgICAgICAgICAvLyBWTkMgZGlzcGxheSByZW5kZXJpbmcgQ2FudmFzIG9iamVjdFxuICAgICAgICAnZm9jdXNDb250YWluZXInOiBkb2N1bWVudCwgICAgICAgICAgICAgLy8gRE9NIGVsZW1lbnQgdGhhdCBjYXB0dXJlcyBrZXlib2FyZCBpbnB1dFxuICAgICAgICAnZW5jcnlwdCc6IGZhbHNlLCAgICAgICAgICAgICAgICAgICAgICAgLy8gVXNlIFRMUy9TU0wvd3NzIGVuY3J5cHRpb25cbiAgICAgICAgJ3RydWVfY29sb3InOiB0cnVlLCAgICAgICAgICAgICAgICAgICAgIC8vIFJlcXVlc3QgdHJ1ZSBjb2xvciBwaXhlbCBkYXRhXG4gICAgICAgICdsb2NhbF9jdXJzb3InOiBmYWxzZSwgICAgICAgICAgICAgICAgICAvLyBSZXF1ZXN0IGxvY2FsbHkgcmVuZGVyZWQgY3Vyc29yXG4gICAgICAgICdzaGFyZWQnOiB0cnVlLCAgICAgICAgICAgICAgICAgICAgICAgICAvLyBSZXF1ZXN0IHNoYXJlZCBtb2RlXG4gICAgICAgICd2aWV3X29ubHknOiBmYWxzZSwgICAgICAgICAgICAgICAgICAgICAvLyBEaXNhYmxlIGNsaWVudCBtb3VzZS9rZXlib2FyZFxuICAgICAgICAneHZwX3Bhc3N3b3JkX3NlcCc6ICdAJywgICAgICAgICAgICAgICAgLy8gU2VwYXJhdG9yIGZvciBYVlAgcGFzc3dvcmQgZmllbGRzXG4gICAgICAgICdkaXNjb25uZWN0VGltZW91dCc6IDMsICAgICAgICAgICAgICAgICAvLyBUaW1lIChzKSB0byB3YWl0IGZvciBkaXNjb25uZWN0aW9uXG4gICAgICAgICd3c1Byb3RvY29scyc6IFsnYmluYXJ5J10sICAgICAgICAgICAgICAvLyBQcm90b2NvbHMgdG8gdXNlIGluIHRoZSBXZWJTb2NrZXQgY29ubmVjdGlvblxuICAgICAgICAncmVwZWF0ZXJJRCc6ICcnLCAgICAgICAgICAgICAgICAgICAgICAgLy8gW1VsdHJhVk5DXSBSZXBlYXRlcklEIHRvIGNvbm5lY3QgdG9cbiAgICAgICAgJ3ZpZXdwb3J0RHJhZyc6IGZhbHNlLCAgICAgICAgICAgICAgICAgIC8vIE1vdmUgdGhlIHZpZXdwb3J0IG9uIG1vdXNlIGRyYWdzXG5cbiAgICAgICAgLy8gQ2FsbGJhY2sgZnVuY3Rpb25zXG4gICAgICAgICdvblVwZGF0ZVN0YXRlJzogZnVuY3Rpb24gKCkgeyB9LCAgICAgICAvLyBvblVwZGF0ZVN0YXRlKHJmYiwgc3RhdGUsIG9sZHN0YXRlLCBzdGF0dXNNc2cpOiBzdGF0ZSB1cGRhdGUvY2hhbmdlXG4gICAgICAgICdvblBhc3N3b3JkUmVxdWlyZWQnOiBmdW5jdGlvbiAoKSB7IH0sICAvLyBvblBhc3N3b3JkUmVxdWlyZWQocmZiKTogVk5DIHBhc3N3b3JkIGlzIHJlcXVpcmVkXG4gICAgICAgICdvbkNsaXBib2FyZCc6IGZ1bmN0aW9uICgpIHsgfSwgICAgICAgICAvLyBvbkNsaXBib2FyZChyZmIsIHRleHQpOiBSRkIgY2xpcGJvYXJkIGNvbnRlbnRzIHJlY2VpdmVkXG4gICAgICAgICdvbkJlbGwnOiBmdW5jdGlvbiAoKSB7IH0sICAgICAgICAgICAgICAvLyBvbkJlbGwocmZiKTogUkZCIEJlbGwgbWVzc2FnZSByZWNlaXZlZFxuICAgICAgICAnb25GQlVSZWNlaXZlJzogZnVuY3Rpb24gKCkgeyB9LCAgICAgICAgLy8gb25GQlVSZWNlaXZlKHJmYiwgZmJ1KTogUkZCIEZCVSByZWNlaXZlZCBidXQgbm90IHlldCBwcm9jZXNzZWRcbiAgICAgICAgJ29uRkJVQ29tcGxldGUnOiBmdW5jdGlvbiAoKSB7IH0sICAgICAgIC8vIG9uRkJVQ29tcGxldGUocmZiLCBmYnUpOiBSRkIgRkJVIHJlY2VpdmVkIGFuZCBwcm9jZXNzZWRcbiAgICAgICAgJ29uRkJSZXNpemUnOiBmdW5jdGlvbiAoKSB7IH0sICAgICAgICAgIC8vIG9uRkJSZXNpemUocmZiLCB3aWR0aCwgaGVpZ2h0KTogZnJhbWUgYnVmZmVyIHJlc2l6ZWRcbiAgICAgICAgJ29uRGVza3RvcE5hbWUnOiBmdW5jdGlvbiAoKSB7IH0sICAgICAgIC8vIG9uRGVza3RvcE5hbWUocmZiLCBuYW1lKTogZGVza3RvcCBuYW1lIHJlY2VpdmVkXG4gICAgICAgICdvblh2cEluaXQnOiBmdW5jdGlvbiAoKSB7IH0gICAgICAgICAgICAvLyBvblh2cEluaXQodmVyc2lvbik6IFhWUCBleHRlbnNpb25zIGFjdGl2ZSBmb3IgdGhpcyBjb25uZWN0aW9uXG4gICAgfSk7XG5cbiAgICAvLyBtYWluIHNldHVwXG4gICAgVXRpbC5EZWJ1ZyhcIj4+IFJGQi5jb25zdHJ1Y3RvclwiKTtcblxuICAgIC8vIHBvcHVsYXRlIGVuY0hhbmRsZXJzIHdpdGggYm91bmQgdmVyc2lvbnNcbiAgICBPYmplY3Qua2V5cyhSRkIuZW5jb2RpbmdIYW5kbGVycykuZm9yRWFjaChmdW5jdGlvbiAoZW5jTmFtZSkge1xuICAgICAgICB0aGlzLl9lbmNIYW5kbGVyc1tlbmNOYW1lXSA9IFJGQi5lbmNvZGluZ0hhbmRsZXJzW2VuY05hbWVdLmJpbmQodGhpcyk7XG4gICAgfS5iaW5kKHRoaXMpKTtcblxuICAgIC8vIENyZWF0ZSBsb29rdXAgdGFibGVzIGJhc2VkIG9uIGVuY29kaW5nIG51bWJlclxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdGhpcy5fZW5jb2RpbmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHRoaXMuX2VuY0hhbmRsZXJzW3RoaXMuX2VuY29kaW5nc1tpXVsxXV0gPSB0aGlzLl9lbmNIYW5kbGVyc1t0aGlzLl9lbmNvZGluZ3NbaV1bMF1dO1xuICAgICAgICB0aGlzLl9lbmNOYW1lc1t0aGlzLl9lbmNvZGluZ3NbaV1bMV1dID0gdGhpcy5fZW5jb2RpbmdzW2ldWzBdO1xuICAgICAgICB0aGlzLl9lbmNTdGF0c1t0aGlzLl9lbmNvZGluZ3NbaV1bMV1dID0gWzAsIDBdO1xuICAgIH1cblxuICAgIC8vIE5COiBub3RoaW5nIHRoYXQgbmVlZHMgZXhwbGljaXQgdGVhcmRvd24gc2hvdWxkIGJlIGRvbmVcbiAgICAvLyBiZWZvcmUgdGhpcyBwb2ludCwgc2luY2UgdGhpcyBjYW4gdGhyb3cgYW4gZXhjZXB0aW9uXG4gICAgdHJ5IHtcbiAgICAgICAgdGhpcy5fZGlzcGxheSA9IG5ldyBEaXNwbGF5KHt0YXJnZXQ6IHRoaXMuX3RhcmdldH0pO1xuICAgIH0gY2F0Y2ggKGV4Yykge1xuICAgICAgICBVdGlsLkVycm9yKFwiRGlzcGxheSBleGNlcHRpb246IFwiICsgZXhjKTtcbiAgICAgICAgdGhyb3cgZXhjO1xuICAgIH1cblxuICAgIHRoaXMuX2tleWJvYXJkID0gbmV3IEtleWJvYXJkKHt0YXJnZXQ6IHRoaXMuX2ZvY3VzQ29udGFpbmVyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbktleVByZXNzOiB0aGlzLl9oYW5kbGVLZXlQcmVzcy5iaW5kKHRoaXMpfSk7XG5cbiAgICB0aGlzLl9tb3VzZSA9IG5ldyBNb3VzZSh7dGFyZ2V0OiB0aGlzLl90YXJnZXQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uTW91c2VCdXR0b246IHRoaXMuX2hhbmRsZU1vdXNlQnV0dG9uLmJpbmQodGhpcyksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uTW91c2VNb3ZlOiB0aGlzLl9oYW5kbGVNb3VzZU1vdmUuYmluZCh0aGlzKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbm90aWZ5OiB0aGlzLl9rZXlib2FyZC5zeW5jLmJpbmQodGhpcy5fa2V5Ym9hcmQpfSk7XG5cbiAgICB0aGlzLl9zb2NrID0gbmV3IFdlYnNvY2soKTtcbiAgICB0aGlzLl9zb2NrLm9uKCdtZXNzYWdlJywgdGhpcy5faGFuZGxlX21lc3NhZ2UuYmluZCh0aGlzKSk7XG4gICAgdGhpcy5fc29jay5vbignb3BlbicsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgaWYgKHRoaXMuX3JmYl9zdGF0ZSA9PT0gJ2Nvbm5lY3QnKSB7XG4gICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgnUHJvdG9jb2xWZXJzaW9uJywgXCJTdGFydGluZyBWTkMgaGFuZHNoYWtlXCIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5fZmFpbChcIkdvdCB1bmV4cGVjdGVkIFdlYlNvY2tldCBjb25uZWN0aW9uXCIpO1xuICAgICAgICB9XG4gICAgfS5iaW5kKHRoaXMpKTtcbiAgICB0aGlzLl9zb2NrLm9uKCdjbG9zZScsIGZ1bmN0aW9uIChlKSB7XG4gICAgICAgIFV0aWwuV2FybihcIldlYlNvY2tldCBvbi1jbG9zZSBldmVudFwiKTtcbiAgICAgICAgdmFyIG1zZyA9IFwiXCI7XG4gICAgICAgIGlmIChlLmNvZGUpIHtcbiAgICAgICAgICAgIG1zZyA9IFwiIChjb2RlOiBcIiArIGUuY29kZTtcbiAgICAgICAgICAgIGlmIChlLnJlYXNvbikge1xuICAgICAgICAgICAgICAgIG1zZyArPSBcIiwgcmVhc29uOiBcIiArIGUucmVhc29uO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbXNnICs9IFwiKVwiO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0aGlzLl9yZmJfc3RhdGUgPT09ICdkaXNjb25uZWN0Jykge1xuICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ2Rpc2Nvbm5lY3RlZCcsICdWTkMgZGlzY29ubmVjdGVkJyArIG1zZyk7XG4gICAgICAgIH0gZWxzZSBpZiAodGhpcy5fcmZiX3N0YXRlID09PSAnUHJvdG9jb2xWZXJzaW9uJykge1xuICAgICAgICAgICAgdGhpcy5fZmFpbCgnRmFpbGVkIHRvIGNvbm5lY3QgdG8gc2VydmVyJyArIG1zZyk7XG4gICAgICAgIH0gZWxzZSBpZiAodGhpcy5fcmZiX3N0YXRlIGluIHsnZmFpbGVkJzogMSwgJ2Rpc2Nvbm5lY3RlZCc6IDF9KSB7XG4gICAgICAgICAgICBVdGlsLkVycm9yKFwiUmVjZWl2ZWQgb25jbG9zZSB3aGlsZSBkaXNjb25uZWN0ZWRcIiArIG1zZyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLl9mYWlsKFwiU2VydmVyIGRpc2Nvbm5lY3RlZFwiICsgbXNnKTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLl9zb2NrLm9mZignY2xvc2UnKTtcbiAgICB9LmJpbmQodGhpcykpO1xuICAgIHRoaXMuX3NvY2sub24oJ2Vycm9yJywgZnVuY3Rpb24gKGUpIHtcbiAgICAgICAgVXRpbC5XYXJuKFwiV2ViU29ja2V0IG9uLWVycm9yIGV2ZW50XCIpO1xuICAgIH0pO1xuXG4gICAgdGhpcy5faW5pdF92YXJzKCk7XG5cbiAgICB2YXIgcm1vZGUgPSB0aGlzLl9kaXNwbGF5LmdldF9yZW5kZXJfbW9kZSgpO1xuICAgIFV0aWwuSW5mbyhcIlVzaW5nIG5hdGl2ZSBXZWJTb2NrZXRzXCIpO1xuICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdsb2FkZWQnLCAnbm9WTkMgcmVhZHk6IG5hdGl2ZSBXZWJTb2NrZXRzLCAnICsgcm1vZGUpO1xuXG4gICAgVXRpbC5EZWJ1ZyhcIjw8IFJGQi5jb25zdHJ1Y3RvclwiKTtcbn07XG5cbihmdW5jdGlvbigpIHtcbiAgICBSRkIucHJvdG90eXBlID0ge1xuICAgICAgICAvLyBQdWJsaWMgbWV0aG9kc1xuICAgICAgICBjb25uZWN0OiBmdW5jdGlvbiAoaG9zdCwgcG9ydCwgcGFzc3dvcmQsIHBhdGgpIHtcbiAgICAgICAgICAgIHRoaXMuX3JmYl9ob3N0ID0gaG9zdDtcbiAgICAgICAgICAgIHRoaXMuX3JmYl9wb3J0ID0gcG9ydDtcbiAgICAgICAgICAgIHRoaXMuX3JmYl9wYXNzd29yZCA9IChwYXNzd29yZCAhPT0gdW5kZWZpbmVkKSA/IHBhc3N3b3JkIDogXCJcIjtcbiAgICAgICAgICAgIHRoaXMuX3JmYl9wYXRoID0gKHBhdGggIT09IHVuZGVmaW5lZCkgPyBwYXRoIDogXCJcIjtcblxuICAgICAgICAgICAgaWYgKCF0aGlzLl9yZmJfaG9zdCB8fCAhdGhpcy5fcmZiX3BvcnQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChcIk11c3Qgc2V0IGhvc3QgYW5kIHBvcnRcIik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdjb25uZWN0Jyk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBkaXNjb25uZWN0OiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgnZGlzY29ubmVjdCcsICdEaXNjb25uZWN0aW5nJyk7XG4gICAgICAgICAgICB0aGlzLl9zb2NrLm9mZignZXJyb3InKTtcbiAgICAgICAgICAgIHRoaXMuX3NvY2sub2ZmKCdtZXNzYWdlJyk7XG4gICAgICAgICAgICB0aGlzLl9zb2NrLm9mZignb3BlbicpO1xuICAgICAgICB9LFxuXG4gICAgICAgIHNlbmRQYXNzd29yZDogZnVuY3Rpb24gKHBhc3N3ZCkge1xuICAgICAgICAgICAgdGhpcy5fcmZiX3Bhc3N3b3JkID0gcGFzc3dkO1xuICAgICAgICAgICAgdGhpcy5fcmZiX3N0YXRlID0gJ0F1dGhlbnRpY2F0aW9uJztcbiAgICAgICAgICAgIHNldFRpbWVvdXQodGhpcy5faW5pdF9tc2cuYmluZCh0aGlzKSwgMCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgc2VuZEN0cmxBbHREZWw6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9yZmJfc3RhdGUgIT09ICdub3JtYWwnIHx8IHRoaXMuX3ZpZXdfb25seSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgIFV0aWwuSW5mbyhcIlNlbmRpbmcgQ3RybC1BbHQtRGVsXCIpO1xuXG4gICAgICAgICAgICBSRkIubWVzc2FnZXMua2V5RXZlbnQodGhpcy5fc29jaywgS2V5VGFibGUuWEtfQ29udHJvbF9MLCAxKTtcbiAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5rZXlFdmVudCh0aGlzLl9zb2NrLCBLZXlUYWJsZS5YS19BbHRfTCwgMSk7XG4gICAgICAgICAgICBSRkIubWVzc2FnZXMua2V5RXZlbnQodGhpcy5fc29jaywgS2V5VGFibGUuWEtfRGVsZXRlLCAxKTtcbiAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5rZXlFdmVudCh0aGlzLl9zb2NrLCBLZXlUYWJsZS5YS19EZWxldGUsIDApO1xuICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmtleUV2ZW50KHRoaXMuX3NvY2ssIEtleVRhYmxlLlhLX0FsdF9MLCAwKTtcbiAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5rZXlFdmVudCh0aGlzLl9zb2NrLCBLZXlUYWJsZS5YS19Db250cm9sX0wsIDApO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgeHZwT3A6IGZ1bmN0aW9uICh2ZXIsIG9wKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fcmZiX3h2cF92ZXIgPCB2ZXIpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICBVdGlsLkluZm8oXCJTZW5kaW5nIFhWUCBvcGVyYXRpb24gXCIgKyBvcCArIFwiICh2ZXJzaW9uIFwiICsgdmVyICsgXCIpXCIpO1xuICAgICAgICAgICAgdGhpcy5fc29jay5zZW5kX3N0cmluZyhcIlxceEZBXFx4MDBcIiArIFN0cmluZy5mcm9tQ2hhckNvZGUodmVyKSArIFN0cmluZy5mcm9tQ2hhckNvZGUob3ApKTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIHh2cFNodXRkb3duOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy54dnBPcCgxLCAyKTtcbiAgICAgICAgfSxcblxuICAgICAgICB4dnBSZWJvb3Q6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLnh2cE9wKDEsIDMpO1xuICAgICAgICB9LFxuXG4gICAgICAgIHh2cFJlc2V0OiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy54dnBPcCgxLCA0KTtcbiAgICAgICAgfSxcblxuICAgICAgICAvLyBTZW5kIGEga2V5IHByZXNzLiBJZiAnZG93bicgaXMgbm90IHNwZWNpZmllZCB0aGVuIHNlbmQgYSBkb3duIGtleVxuICAgICAgICAvLyBmb2xsb3dlZCBieSBhbiB1cCBrZXkuXG4gICAgICAgIHNlbmRLZXk6IGZ1bmN0aW9uIChjb2RlLCBkb3duKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fcmZiX3N0YXRlICE9PSBcIm5vcm1hbFwiIHx8IHRoaXMuX3ZpZXdfb25seSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgIGlmICh0eXBlb2YgZG93biAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgICAgICBVdGlsLkluZm8oXCJTZW5kaW5nIGtleSBjb2RlIChcIiArIChkb3duID8gXCJkb3duXCIgOiBcInVwXCIpICsgXCIpOiBcIiArIGNvZGUpO1xuICAgICAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5rZXlFdmVudCh0aGlzLl9zb2NrLCBjb2RlLCBkb3duID8gMSA6IDApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBVdGlsLkluZm8oXCJTZW5kaW5nIGtleSBjb2RlIChkb3duICsgdXApOiBcIiArIGNvZGUpO1xuICAgICAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5rZXlFdmVudCh0aGlzLl9zb2NrLCBjb2RlLCAxKTtcbiAgICAgICAgICAgICAgICBSRkIubWVzc2FnZXMua2V5RXZlbnQodGhpcy5fc29jaywgY29kZSwgMCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBjbGlwYm9hcmRQYXN0ZUZyb206IGZ1bmN0aW9uICh0ZXh0KSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fcmZiX3N0YXRlICE9PSAnbm9ybWFsJykgeyByZXR1cm47IH1cbiAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5jbGllbnRDdXRUZXh0KHRoaXMuX3NvY2ssIHRleHQpO1xuICAgICAgICB9LFxuXG4gICAgICAgIC8vIFJlcXVlc3RzIGEgY2hhbmdlIG9mIHJlbW90ZSBkZXNrdG9wIHNpemUuIFRoaXMgbWVzc2FnZSBpcyBhbiBleHRlbnNpb25cbiAgICAgICAgLy8gYW5kIG1heSBvbmx5IGJlIHNlbnQgaWYgd2UgaGF2ZSByZWNlaXZlZCBhbiBFeHRlbmRlZERlc2t0b3BTaXplIG1lc3NhZ2VcbiAgICAgICAgcmVxdWVzdERlc2t0b3BTaXplOiBmdW5jdGlvbiAod2lkdGgsIGhlaWdodCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3JmYl9zdGF0ZSAhPT0gXCJub3JtYWxcIikgeyByZXR1cm47IH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX3N1cHBvcnRzU2V0RGVza3RvcFNpemUpIHtcbiAgICAgICAgICAgICAgICBSRkIubWVzc2FnZXMuc2V0RGVza3RvcFNpemUodGhpcy5fc29jaywgd2lkdGgsIGhlaWdodCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fc2NyZWVuX2lkLCB0aGlzLl9zY3JlZW5fZmxhZ3MpO1xuICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suZmx1c2goKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuXG4gICAgICAgIC8vIFByaXZhdGUgbWV0aG9kc1xuXG4gICAgICAgIF9jb25uZWN0OiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBVdGlsLkRlYnVnKFwiPj4gUkZCLmNvbm5lY3RcIik7XG5cbiAgICAgICAgICAgIHZhciB1cmk7XG4gICAgICAgICAgICBpZiAodHlwZW9mIFVzaW5nU29ja2V0SU8gIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgICAgICAgdXJpID0gJ2h0dHAnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB1cmkgPSB0aGlzLl9lbmNyeXB0ID8gJ3dzcycgOiAnd3MnO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB1cmkgKz0gJzovLycgKyB0aGlzLl9yZmJfaG9zdCArICc6JyArIHRoaXMuX3JmYl9wb3J0ICsgJy8nICsgdGhpcy5fcmZiX3BhdGg7XG4gICAgICAgICAgICBVdGlsLkluZm8oXCJjb25uZWN0aW5nIHRvIFwiICsgdXJpKTtcblxuICAgICAgICAgICAgdGhpcy5fc29jay5vcGVuKHVyaSwgdGhpcy5fd3NQcm90b2NvbHMpO1xuXG4gICAgICAgICAgICBVdGlsLkRlYnVnKFwiPDwgUkZCLmNvbm5lY3RcIik7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2luaXRfdmFyczogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgLy8gcmVzZXQgc3RhdGVcbiAgICAgICAgICAgIHRoaXMuX0ZCVS5yZWN0cyAgICAgICAgPSAwO1xuICAgICAgICAgICAgdGhpcy5fRkJVLnN1YnJlY3RzICAgICA9IDA7ICAvLyBSUkUgYW5kIEhFWFRJTEVcbiAgICAgICAgICAgIHRoaXMuX0ZCVS5saW5lcyAgICAgICAgPSAwOyAgLy8gUkFXXG4gICAgICAgICAgICB0aGlzLl9GQlUudGlsZXMgICAgICAgID0gMDsgIC8vIEhFWFRJTEVcbiAgICAgICAgICAgIHRoaXMuX0ZCVS56bGlicyAgICAgICAgPSBbXTsgLy8gVElHSFQgemxpYiBlbmNvZGVyc1xuICAgICAgICAgICAgdGhpcy5fbW91c2VfYnV0dG9uTWFzayA9IDA7XG4gICAgICAgICAgICB0aGlzLl9tb3VzZV9hcnIgICAgICAgID0gW107XG4gICAgICAgICAgICB0aGlzLl9yZmJfdGlnaHR2bmMgICAgID0gZmFsc2U7XG5cbiAgICAgICAgICAgIC8vIENsZWFyIHRoZSBwZXIgY29ubmVjdGlvbiBlbmNvZGluZyBzdGF0c1xuICAgICAgICAgICAgdmFyIGk7XG4gICAgICAgICAgICBmb3IgKGkgPSAwOyBpIDwgdGhpcy5fZW5jb2RpbmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fZW5jU3RhdHNbdGhpcy5fZW5jb2RpbmdzW2ldWzFdXVswXSA9IDA7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZvciAoaSA9IDA7IGkgPCA0OyBpKyspIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUuemxpYnNbaV0gPSBuZXcgSW5mbGF0b3IuSW5mbGF0ZSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIF9wcmludF9zdGF0czogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgVXRpbC5JbmZvKFwiRW5jb2Rpbmcgc3RhdHMgZm9yIHRoaXMgY29ubmVjdGlvbjpcIik7XG4gICAgICAgICAgICB2YXIgaSwgcztcbiAgICAgICAgICAgIGZvciAoaSA9IDA7IGkgPCB0aGlzLl9lbmNvZGluZ3MubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgICBzID0gdGhpcy5fZW5jU3RhdHNbdGhpcy5fZW5jb2RpbmdzW2ldWzFdXTtcbiAgICAgICAgICAgICAgICBpZiAoc1swXSArIHNbMV0gPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIFV0aWwuSW5mbyhcIiAgICBcIiArIHRoaXMuX2VuY29kaW5nc1tpXVswXSArIFwiOiBcIiArIHNbMF0gKyBcIiByZWN0c1wiKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIFV0aWwuSW5mbyhcIkVuY29kaW5nIHN0YXRzIHNpbmNlIHBhZ2UgbG9hZDpcIik7XG4gICAgICAgICAgICBmb3IgKGkgPSAwOyBpIDwgdGhpcy5fZW5jb2RpbmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgcyA9IHRoaXMuX2VuY1N0YXRzW3RoaXMuX2VuY29kaW5nc1tpXVsxXV07XG4gICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiICAgIFwiICsgdGhpcy5fZW5jb2RpbmdzW2ldWzBdICsgXCI6IFwiICsgc1sxXSArIFwiIHJlY3RzXCIpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIF9jbGVhbnVwU29ja2V0OiBmdW5jdGlvbiAoc3RhdGUpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9tc2dUaW1lcikge1xuICAgICAgICAgICAgICAgIGNsZWFySW50ZXJ2YWwodGhpcy5fbXNnVGltZXIpO1xuICAgICAgICAgICAgICAgIHRoaXMuX21zZ1RpbWVyID0gbnVsbDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX2Rpc3BsYXkgJiYgdGhpcy5fZGlzcGxheS5nZXRfY29udGV4dCgpKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fa2V5Ym9hcmQudW5ncmFiKCk7XG4gICAgICAgICAgICAgICAgdGhpcy5fbW91c2UudW5ncmFiKCk7XG4gICAgICAgICAgICAgICAgaWYgKHN0YXRlICE9PSAnY29ubmVjdCcgJiYgc3RhdGUgIT09ICdsb2FkZWQnKSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuZGVmYXVsdEN1cnNvcigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoVXRpbC5nZXRfbG9nZ2luZygpICE9PSAnZGVidWcnIHx8IHN0YXRlID09PSAnbG9hZGVkJykge1xuICAgICAgICAgICAgICAgICAgICAvLyBTaG93IG5vVk5DIGxvZ28gb24gbG9hZCBhbmQgd2hlbiBkaXNjb25uZWN0ZWQsIHVubGVzcyBpblxuICAgICAgICAgICAgICAgICAgICAvLyBkZWJ1ZyBtb2RlXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuY2xlYXIoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuX3NvY2suY2xvc2UoKTtcbiAgICAgICAgfSxcblxuICAgICAgICAvKlxuICAgICAgICAgKiBQYWdlIHN0YXRlczpcbiAgICAgICAgICogICBsb2FkZWQgICAgICAgLSBwYWdlIGxvYWQsIGVxdWl2YWxlbnQgdG8gZGlzY29ubmVjdGVkXG4gICAgICAgICAqICAgZGlzY29ubmVjdGVkIC0gaWRsZSBzdGF0ZVxuICAgICAgICAgKiAgIGNvbm5lY3QgICAgICAtIHN0YXJ0aW5nIHRvIGNvbm5lY3QgKHRvIFByb3RvY29sVmVyc2lvbilcbiAgICAgICAgICogICBub3JtYWwgICAgICAgLSBjb25uZWN0ZWRcbiAgICAgICAgICogICBkaXNjb25uZWN0ICAgLSBzdGFydGluZyB0byBkaXNjb25uZWN0XG4gICAgICAgICAqICAgZmFpbGVkICAgICAgIC0gYWJub3JtYWwgZGlzY29ubmVjdFxuICAgICAgICAgKiAgIGZhdGFsICAgICAgICAtIGZhaWxlZCB0byBsb2FkIHBhZ2UsIG9yIGZhdGFsIGVycm9yXG4gICAgICAgICAqXG4gICAgICAgICAqIFJGQiBwcm90b2NvbCBpbml0aWFsaXphdGlvbiBzdGF0ZXM6XG4gICAgICAgICAqICAgUHJvdG9jb2xWZXJzaW9uXG4gICAgICAgICAqICAgU2VjdXJpdHlcbiAgICAgICAgICogICBBdXRoZW50aWNhdGlvblxuICAgICAgICAgKiAgIHBhc3N3b3JkICAgICAtIHdhaXRpbmcgZm9yIHBhc3N3b3JkLCBub3QgcGFydCBvZiBSRkJcbiAgICAgICAgICogICBTZWN1cml0eVJlc3VsdFxuICAgICAgICAgKiAgIENsaWVudEluaXRpYWxpemF0aW9uIC0gbm90IHRyaWdnZXJlZCBieSBzZXJ2ZXIgbWVzc2FnZVxuICAgICAgICAgKiAgIFNlcnZlckluaXRpYWxpemF0aW9uICh0byBub3JtYWwpXG4gICAgICAgICAqL1xuICAgICAgICBfdXBkYXRlU3RhdGU6IGZ1bmN0aW9uIChzdGF0ZSwgc3RhdHVzTXNnKSB7XG4gICAgICAgICAgICB2YXIgb2xkc3RhdGUgPSB0aGlzLl9yZmJfc3RhdGU7XG5cbiAgICAgICAgICAgIGlmIChzdGF0ZSA9PT0gb2xkc3RhdGUpIHtcbiAgICAgICAgICAgICAgICAvLyBBbHJlYWR5IGhlcmUsIGlnbm9yZVxuICAgICAgICAgICAgICAgIFV0aWwuRGVidWcoXCJBbHJlYWR5IGluIHN0YXRlICdcIiArIHN0YXRlICsgXCInLCBpZ25vcmluZ1wiKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLypcbiAgICAgICAgICAgICAqIFRoZXNlIGFyZSBkaXNjb25uZWN0ZWQgc3RhdGVzLiBBIHByZXZpb3VzIGNvbm5lY3QgbWF5XG4gICAgICAgICAgICAgKiBhc3luY2hyb25vdXNseSBjYXVzZSBhIGNvbm5lY3Rpb24gc28gbWFrZSBzdXJlIHdlIGFyZSBjbG9zZWQuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGlmIChzdGF0ZSBpbiB7J2Rpc2Nvbm5lY3RlZCc6IDEsICdsb2FkZWQnOiAxLCAnY29ubmVjdCc6IDEsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICdkaXNjb25uZWN0JzogMSwgJ2ZhaWxlZCc6IDEsICdmYXRhbCc6IDF9KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fY2xlYW51cFNvY2tldChzdGF0ZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvbGRzdGF0ZSA9PT0gJ2ZhdGFsJykge1xuICAgICAgICAgICAgICAgIFV0aWwuRXJyb3IoJ0ZhdGFsIGVycm9yLCBjYW5ub3QgY29udGludWUnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFyIGNtc2cgPSB0eXBlb2Yoc3RhdHVzTXNnKSAhPT0gJ3VuZGVmaW5lZCcgPyAoXCIgTXNnOiBcIiArIHN0YXR1c01zZykgOiBcIlwiO1xuICAgICAgICAgICAgdmFyIGZ1bGxtc2cgPSBcIk5ldyBzdGF0ZSAnXCIgKyBzdGF0ZSArIFwiJywgd2FzICdcIiArIG9sZHN0YXRlICsgXCInLlwiICsgY21zZztcbiAgICAgICAgICAgIGlmIChzdGF0ZSA9PT0gJ2ZhaWxlZCcgfHwgc3RhdGUgPT09ICdmYXRhbCcpIHtcbiAgICAgICAgICAgICAgICBVdGlsLkVycm9yKGNtc2cpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBVdGlsLldhcm4oY21zZyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvbGRzdGF0ZSA9PT0gJ2ZhaWxlZCcgJiYgc3RhdGUgPT09ICdkaXNjb25uZWN0ZWQnKSB7XG4gICAgICAgICAgICAgICAgLy8gZG8gZGlzY29ubmVjdCBhY3Rpb24sIGJ1dCBzdGF5IGluIGZhaWxlZCBzdGF0ZVxuICAgICAgICAgICAgICAgIHRoaXMuX3JmYl9zdGF0ZSA9ICdmYWlsZWQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9yZmJfc3RhdGUgPSBzdGF0ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX2Rpc2Nvbm5UaW1lciAmJiB0aGlzLl9yZmJfc3RhdGUgIT09ICdkaXNjb25uZWN0Jykge1xuICAgICAgICAgICAgICAgIFV0aWwuRGVidWcoXCJDbGVhcmluZyBkaXNjb25uZWN0IHRpbWVyXCIpO1xuICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aGlzLl9kaXNjb25uVGltZXIpO1xuICAgICAgICAgICAgICAgIHRoaXMuX2Rpc2Nvbm5UaW1lciA9IG51bGw7XG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5vZmYoJ2Nsb3NlJyk7ICAvLyBtYWtlIHN1cmUgd2UgZG9uJ3QgZ2V0IGEgZG91YmxlIGV2ZW50XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHN3aXRjaCAoc3RhdGUpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdub3JtYWwnOlxuICAgICAgICAgICAgICAgICAgICBpZiAob2xkc3RhdGUgPT09ICdkaXNjb25uZWN0ZWQnIHx8IG9sZHN0YXRlID09PSAnZmFpbGVkJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgVXRpbC5FcnJvcihcIkludmFsaWQgdHJhbnNpdGlvbiBmcm9tICdkaXNjb25uZWN0ZWQnIG9yICdmYWlsZWQnIHRvICdub3JtYWwnXCIpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnY29ubmVjdCc6XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2luaXRfdmFycygpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9jb25uZWN0KCk7XG4gICAgICAgICAgICAgICAgICAgIC8vIFdlYlNvY2tldC5vbm9wZW4gdHJhbnNpdGlvbnMgdG8gJ1Byb3RvY29sVmVyc2lvbidcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdkaXNjb25uZWN0JzpcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZGlzY29ublRpbWVyID0gc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9mYWlsKFwiRGlzY29ubmVjdCB0aW1lb3V0XCIpO1xuICAgICAgICAgICAgICAgICAgICB9LmJpbmQodGhpcyksIHRoaXMuX2Rpc2Nvbm5lY3RUaW1lb3V0ICogMTAwMCk7XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJpbnRfc3RhdHMoKTtcblxuICAgICAgICAgICAgICAgICAgICAvLyBXZWJTb2NrZXQub25jbG9zZSB0cmFuc2l0aW9ucyB0byAnZGlzY29ubmVjdGVkJ1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2ZhaWxlZCc6XG4gICAgICAgICAgICAgICAgICAgIGlmIChvbGRzdGF0ZSA9PT0gJ2Rpc2Nvbm5lY3RlZCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFV0aWwuRXJyb3IoXCJJbnZhbGlkIHRyYW5zaXRpb24gZnJvbSAnZGlzY29ubmVjdGVkJyB0byAnZmFpbGVkJ1wiKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChvbGRzdGF0ZSA9PT0gJ25vcm1hbCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFV0aWwuRXJyb3IoXCJFcnJvciB3aGlsZSBjb25uZWN0ZWQuXCIpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKG9sZHN0YXRlID09PSAnaW5pdCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFV0aWwuRXJyb3IoXCJFcnJvciB3aGlsZSBpbml0aWFsaXppbmcuXCIpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy8gTWFrZSBzdXJlIHdlIHRyYW5zaXRpb24gdG8gZGlzY29ubmVjdGVkXG4gICAgICAgICAgICAgICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ2Rpc2Nvbm5lY3RlZCcpO1xuICAgICAgICAgICAgICAgICAgICB9LmJpbmQodGhpcyksIDUwKTtcblxuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIC8vIE5vIHN0YXRlIGNoYW5nZSBhY3Rpb24gdG8gdGFrZVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAob2xkc3RhdGUgPT09ICdmYWlsZWQnICYmIHN0YXRlID09PSAnZGlzY29ubmVjdGVkJykge1xuICAgICAgICAgICAgICAgIHRoaXMuX29uVXBkYXRlU3RhdGUodGhpcywgc3RhdGUsIG9sZHN0YXRlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fb25VcGRhdGVTdGF0ZSh0aGlzLCBzdGF0ZSwgb2xkc3RhdGUsIHN0YXR1c01zZyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2ZhaWw6IGZ1bmN0aW9uIChtc2cpIHtcbiAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdmYWlsZWQnLCBtc2cpO1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9oYW5kbGVfbWVzc2FnZTogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclFsZW4oKSA9PT0gMCkge1xuICAgICAgICAgICAgICAgIFV0aWwuV2FybihcImhhbmRsZV9tZXNzYWdlIGNhbGxlZCBvbiBhbiBlbXB0eSByZWNlaXZlIHF1ZXVlXCIpO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3dpdGNoICh0aGlzLl9yZmJfc3RhdGUpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdkaXNjb25uZWN0ZWQnOlxuICAgICAgICAgICAgICAgIGNhc2UgJ2ZhaWxlZCc6XG4gICAgICAgICAgICAgICAgICAgIFV0aWwuRXJyb3IoXCJHb3QgZGF0YSB3aGlsZSBkaXNjb25uZWN0ZWRcIik7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgJ25vcm1hbCc6XG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9ub3JtYWxfbXNnKCkgJiYgdGhpcy5fc29jay5yUWxlbigpID4gMCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gdHJ1ZSBtZWFucyB3ZSBjYW4gY29udGludWUgcHJvY2Vzc2luZ1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gR2l2ZSBvdGhlciBldmVudHMgYSBjaGFuY2UgdG8gcnVuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fbXNnVGltZXIgPT09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBVdGlsLkRlYnVnKFwiTW9yZSBkYXRhIHRvIHByb2Nlc3MsIGNyZWF0aW5nIHRpbWVyXCIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX21zZ1RpbWVyID0gc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX21zZ1RpbWVyID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5faGFuZGxlX21lc3NhZ2UoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LmJpbmQodGhpcyksIDApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBVdGlsLkRlYnVnKFwiTW9yZSBkYXRhIHRvIHByb2Nlc3MsIGV4aXN0aW5nIHRpbWVyXCIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2luaXRfbXNnKCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIF9oYW5kbGVLZXlQcmVzczogZnVuY3Rpb24gKGtleWV2ZW50KSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fdmlld19vbmx5KSB7IHJldHVybjsgfSAvLyBWaWV3IG9ubHksIHNraXAga2V5Ym9hcmQsIGV2ZW50c1xuXG4gICAgICAgICAgICB2YXIgZG93biA9IChrZXlldmVudC50eXBlID09ICdrZXlkb3duJyk7XG4gICAgICAgICAgICBpZiAodGhpcy5fcWVtdUV4dEtleUV2ZW50U3VwcG9ydGVkKSB7XG4gICAgICAgICAgICAgICAgdmFyIHNjYW5jb2RlID0gWHRTY2FuY29kZVtrZXlldmVudC5jb2RlXTtcbiAgICAgICAgICAgICAgICBpZiAoc2NhbmNvZGUpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGtleXN5bSA9IGtleWV2ZW50LmtleXN5bTtcbiAgICAgICAgICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLlFFTVVFeHRlbmRlZEtleUV2ZW50KHRoaXMuX3NvY2ssIGtleXN5bSwgZG93biwgc2NhbmNvZGUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIFV0aWwuRXJyb3IoJ1VuYWJsZSB0byBmaW5kIGEgeHQgc2NhbmNvZGUgZm9yIGNvZGUgPSAnICsga2V5ZXZlbnQuY29kZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBrZXlzeW0gPSBrZXlldmVudC5rZXlzeW0ua2V5c3ltO1xuICAgICAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5rZXlFdmVudCh0aGlzLl9zb2NrLCBrZXlzeW0sIGRvd24pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIF9oYW5kbGVNb3VzZUJ1dHRvbjogZnVuY3Rpb24gKHgsIHksIGRvd24sIGJtYXNrKSB7XG4gICAgICAgICAgICBpZiAoZG93bikge1xuICAgICAgICAgICAgICAgIHRoaXMuX21vdXNlX2J1dHRvbk1hc2sgfD0gYm1hc2s7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX21vdXNlX2J1dHRvbk1hc2sgXj0gYm1hc2s7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl92aWV3cG9ydERyYWcpIHtcbiAgICAgICAgICAgICAgICBpZiAoZG93biAmJiAhdGhpcy5fdmlld3BvcnREcmFnZ2luZykge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl92aWV3cG9ydERyYWdnaW5nID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdmlld3BvcnREcmFnUG9zID0geyd4JzogeCwgJ3knOiB5fTtcblxuICAgICAgICAgICAgICAgICAgICAvLyBTa2lwIHNlbmRpbmcgbW91c2UgZXZlbnRzXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl92aWV3cG9ydERyYWdnaW5nID0gZmFsc2U7XG5cbiAgICAgICAgICAgICAgICAgICAgLy8gSWYgdGhlIHZpZXdwb3J0IGRpZG4ndCBhY3R1YWxseSBtb3ZlLCB0aGVuIHRyZWF0IGFzIGEgbW91c2UgY2xpY2sgZXZlbnRcbiAgICAgICAgICAgICAgICAgICAgLy8gU2VuZCB0aGUgYnV0dG9uIGRvd24gZXZlbnQgaGVyZSwgYXMgdGhlIGJ1dHRvbiB1cCBldmVudCBpcyBzZW50IGF0IHRoZSBlbmQgb2YgdGhpcyBmdW5jdGlvblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXRoaXMuX3ZpZXdwb3J0SGFzTW92ZWQgJiYgIXRoaXMuX3ZpZXdfb25seSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLnBvaW50ZXJFdmVudCh0aGlzLl9zb2NrLCB0aGlzLl9kaXNwbGF5LmFic1goeCksIHRoaXMuX2Rpc3BsYXkuYWJzWSh5KSwgYm1hc2spO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3ZpZXdwb3J0SGFzTW92ZWQgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl92aWV3X29ubHkpIHsgcmV0dXJuOyB9IC8vIFZpZXcgb25seSwgc2tpcCBtb3VzZSBldmVudHNcblxuICAgICAgICAgICAgaWYgKHRoaXMuX3JmYl9zdGF0ZSAhPT0gXCJub3JtYWxcIikgeyByZXR1cm47IH1cbiAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5wb2ludGVyRXZlbnQodGhpcy5fc29jaywgdGhpcy5fZGlzcGxheS5hYnNYKHgpLCB0aGlzLl9kaXNwbGF5LmFic1koeSksIHRoaXMuX21vdXNlX2J1dHRvbk1hc2spO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9oYW5kbGVNb3VzZU1vdmU6IGZ1bmN0aW9uICh4LCB5KSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fdmlld3BvcnREcmFnZ2luZykge1xuICAgICAgICAgICAgICAgIHZhciBkZWx0YVggPSB0aGlzLl92aWV3cG9ydERyYWdQb3MueCAtIHg7XG4gICAgICAgICAgICAgICAgdmFyIGRlbHRhWSA9IHRoaXMuX3ZpZXdwb3J0RHJhZ1Bvcy55IC0geTtcblxuICAgICAgICAgICAgICAgIC8vIFRoZSBnb2FsIGlzIHRvIHRyaWdnZXIgb24gYSBjZXJ0YWluIHBoeXNpY2FsIHdpZHRoLCB0aGVcbiAgICAgICAgICAgICAgICAvLyBkZXZpY2VQaXhlbFJhdGlvIGJyaW5ncyB1cyBhIGJpdCBjbG9zZXIgYnV0IGlzIG5vdCBvcHRpbWFsLlxuICAgICAgICAgICAgICAgIHZhciBkcmFnVGhyZXNob2xkID0gMTAgKiAod2luZG93LmRldmljZVBpeGVsUmF0aW8gfHwgMSk7XG5cbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fdmlld3BvcnRIYXNNb3ZlZCB8fCAoTWF0aC5hYnMoZGVsdGFYKSA+IGRyYWdUaHJlc2hvbGQgfHxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgTWF0aC5hYnMoZGVsdGFZKSA+IGRyYWdUaHJlc2hvbGQpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3ZpZXdwb3J0SGFzTW92ZWQgPSB0cnVlO1xuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3ZpZXdwb3J0RHJhZ1BvcyA9IHsneCc6IHgsICd5JzogeX07XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkudmlld3BvcnRDaGFuZ2VQb3MoZGVsdGFYLCBkZWx0YVkpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vIFNraXAgc2VuZGluZyBtb3VzZSBldmVudHNcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl92aWV3X29ubHkpIHsgcmV0dXJuOyB9IC8vIFZpZXcgb25seSwgc2tpcCBtb3VzZSBldmVudHNcblxuICAgICAgICAgICAgaWYgKHRoaXMuX3JmYl9zdGF0ZSAhPT0gXCJub3JtYWxcIikgeyByZXR1cm47IH1cbiAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5wb2ludGVyRXZlbnQodGhpcy5fc29jaywgdGhpcy5fZGlzcGxheS5hYnNYKHgpLCB0aGlzLl9kaXNwbGF5LmFic1koeSksIHRoaXMuX21vdXNlX2J1dHRvbk1hc2spO1xuICAgICAgICB9LFxuXG4gICAgICAgIC8vIE1lc3NhZ2UgSGFuZGxlcnNcblxuICAgICAgICBfbmVnb3RpYXRlX3Byb3RvY29sX3ZlcnNpb246IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRbGVuKCkgPCAxMikge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiSW5jb21wbGV0ZSBwcm90b2NvbCB2ZXJzaW9uXCIpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YXIgc3ZlcnNpb24gPSB0aGlzLl9zb2NrLnJRc2hpZnRTdHIoMTIpLnN1YnN0cig0LCA3KTtcbiAgICAgICAgICAgIFV0aWwuSW5mbyhcIlNlcnZlciBQcm90b2NvbFZlcnNpb246IFwiICsgc3ZlcnNpb24pO1xuICAgICAgICAgICAgdmFyIGlzX3JlcGVhdGVyID0gMDtcbiAgICAgICAgICAgIHN3aXRjaCAoc3ZlcnNpb24pIHtcbiAgICAgICAgICAgICAgICBjYXNlIFwiMDAwLjAwMFwiOiAgLy8gVWx0cmFWTkMgcmVwZWF0ZXJcbiAgICAgICAgICAgICAgICAgICAgaXNfcmVwZWF0ZXIgPSAxO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIFwiMDAzLjAwM1wiOlxuICAgICAgICAgICAgICAgIGNhc2UgXCIwMDMuMDA2XCI6ICAvLyBVbHRyYVZOQ1xuICAgICAgICAgICAgICAgIGNhc2UgXCIwMDMuODg5XCI6ICAvLyBBcHBsZSBSZW1vdGUgRGVza3RvcFxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9yZmJfdmVyc2lvbiA9IDMuMztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSBcIjAwMy4wMDdcIjpcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcmZiX3ZlcnNpb24gPSAzLjc7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgXCIwMDMuMDA4XCI6XG4gICAgICAgICAgICAgICAgY2FzZSBcIjAwNC4wMDBcIjogIC8vIEludGVsIEFNVCBLVk1cbiAgICAgICAgICAgICAgICBjYXNlIFwiMDA0LjAwMVwiOiAgLy8gUmVhbFZOQyA0LjZcbiAgICAgICAgICAgICAgICBjYXNlIFwiMDA1LjAwMFwiOiAgLy8gUmVhbFZOQyA1LjNcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcmZiX3ZlcnNpb24gPSAzLjg7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiSW52YWxpZCBzZXJ2ZXIgdmVyc2lvbiBcIiArIHN2ZXJzaW9uKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGlzX3JlcGVhdGVyKSB7XG4gICAgICAgICAgICAgICAgdmFyIHJlcGVhdGVySUQgPSB0aGlzLl9yZXBlYXRlcklEO1xuICAgICAgICAgICAgICAgIHdoaWxlIChyZXBlYXRlcklELmxlbmd0aCA8IDI1MCkge1xuICAgICAgICAgICAgICAgICAgICByZXBlYXRlcklEICs9IFwiXFwwXCI7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suc2VuZF9zdHJpbmcocmVwZWF0ZXJJRCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9yZmJfdmVyc2lvbiA+IHRoaXMuX3JmYl9tYXhfdmVyc2lvbikge1xuICAgICAgICAgICAgICAgIHRoaXMuX3JmYl92ZXJzaW9uID0gdGhpcy5fcmZiX21heF92ZXJzaW9uO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YXIgY3ZlcnNpb24gPSBcIjAwXCIgKyBwYXJzZUludCh0aGlzLl9yZmJfdmVyc2lvbiwgMTApICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIFwiLjAwXCIgKyAoKHRoaXMuX3JmYl92ZXJzaW9uICogMTApICUgMTApO1xuICAgICAgICAgICAgdGhpcy5fc29jay5zZW5kX3N0cmluZyhcIlJGQiBcIiArIGN2ZXJzaW9uICsgXCJcXG5cIik7XG4gICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgnU2VjdXJpdHknLCAnU2VudCBQcm90b2NvbFZlcnNpb246ICcgKyBjdmVyc2lvbik7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX25lZ290aWF0ZV9zZWN1cml0eTogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3JmYl92ZXJzaW9uID49IDMuNykge1xuICAgICAgICAgICAgICAgIC8vIFNlcnZlciBzZW5kcyBzdXBwb3J0ZWQgbGlzdCwgY2xpZW50IGRlY2lkZXNcbiAgICAgICAgICAgICAgICB2YXIgbnVtX3R5cGVzID0gdGhpcy5fc29jay5yUXNoaWZ0OCgpO1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcInNlY3VyaXR5IHR5cGVcIiwgbnVtX3R5cGVzLCAxKSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgICAgIGlmIChudW1fdHlwZXMgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIHN0cmxlbiA9IHRoaXMuX3NvY2suclFzaGlmdDMyKCk7XG4gICAgICAgICAgICAgICAgICAgIHZhciByZWFzb24gPSB0aGlzLl9zb2NrLnJRc2hpZnRTdHIoc3RybGVuKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJTZWN1cml0eSBmYWlsdXJlOiBcIiArIHJlYXNvbik7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhpcy5fcmZiX2F1dGhfc2NoZW1lID0gMDtcbiAgICAgICAgICAgICAgICB2YXIgdHlwZXMgPSB0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyhudW1fdHlwZXMpO1xuICAgICAgICAgICAgICAgIFV0aWwuRGVidWcoXCJTZXJ2ZXIgc2VjdXJpdHkgdHlwZXM6IFwiICsgdHlwZXMpO1xuICAgICAgICAgICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdHlwZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVzW2ldID4gdGhpcy5fcmZiX2F1dGhfc2NoZW1lICYmICh0eXBlc1tpXSA8PSAxNiB8fCB0eXBlc1tpXSA9PSAyMikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3JmYl9hdXRoX3NjaGVtZSA9IHR5cGVzW2ldO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3JmYl9hdXRoX3NjaGVtZSA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChcIlVuc3VwcG9ydGVkIHNlY3VyaXR5IHR5cGVzOiBcIiArIHR5cGVzKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnNlbmQoW3RoaXMuX3JmYl9hdXRoX3NjaGVtZV0pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBTZXJ2ZXIgZGVjaWRlc1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcInNlY3VyaXR5IHNjaGVtZVwiLCA0KSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgICAgICB0aGlzLl9yZmJfYXV0aF9zY2hlbWUgPSB0aGlzLl9zb2NrLnJRc2hpZnQzMigpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgnQXV0aGVudGljYXRpb24nLCAnQXV0aGVudGljYXRpbmcgdXNpbmcgc2NoZW1lOiAnICsgdGhpcy5fcmZiX2F1dGhfc2NoZW1lKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9pbml0X21zZygpOyAvLyBqdW1wIHRvIGF1dGhlbnRpY2F0aW9uXG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gYXV0aGVudGljYXRpb25cbiAgICAgICAgX25lZ290aWF0ZV94dnBfYXV0aDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdmFyIHh2cF9zZXAgPSB0aGlzLl94dnBfcGFzc3dvcmRfc2VwO1xuICAgICAgICAgICAgdmFyIHh2cF9hdXRoID0gdGhpcy5fcmZiX3Bhc3N3b3JkLnNwbGl0KHh2cF9zZXApO1xuICAgICAgICAgICAgaWYgKHh2cF9hdXRoLmxlbmd0aCA8IDMpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgncGFzc3dvcmQnLCAnWFZQIGNyZWRlbnRpYWxzIHJlcXVpcmVkICh1c2VyJyArIHh2cF9zZXAgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICd0YXJnZXQnICsgeHZwX3NlcCArICdwYXNzd29yZCkgLS0gZ290IG9ubHkgJyArIHRoaXMuX3JmYl9wYXNzd29yZCk7XG4gICAgICAgICAgICAgICAgdGhpcy5fb25QYXNzd29yZFJlcXVpcmVkKHRoaXMpO1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFyIHh2cF9hdXRoX3N0ciA9IFN0cmluZy5mcm9tQ2hhckNvZGUoeHZwX2F1dGhbMF0ubGVuZ3RoKSArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgU3RyaW5nLmZyb21DaGFyQ29kZSh4dnBfYXV0aFsxXS5sZW5ndGgpICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB4dnBfYXV0aFswXSArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeHZwX2F1dGhbMV07XG4gICAgICAgICAgICB0aGlzLl9zb2NrLnNlbmRfc3RyaW5nKHh2cF9hdXRoX3N0cik7XG4gICAgICAgICAgICB0aGlzLl9yZmJfcGFzc3dvcmQgPSB4dnBfYXV0aC5zbGljZSgyKS5qb2luKHh2cF9zZXApO1xuICAgICAgICAgICAgdGhpcy5fcmZiX2F1dGhfc2NoZW1lID0gMjtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9uZWdvdGlhdGVfYXV0aGVudGljYXRpb24oKTtcbiAgICAgICAgfSxcblxuICAgICAgICBfbmVnb3RpYXRlX3N0ZF92bmNfYXV0aDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3JmYl9wYXNzd29yZC5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICAvLyBOb3RpZnkgdmlhIGJvdGggY2FsbGJhY2tzIHNpbmNlIGl0J3Mga2luZCBvZlxuICAgICAgICAgICAgICAgIC8vIGFuIFJGQiBzdGF0ZSBjaGFuZ2UgYW5kIGEgVUkgaW50ZXJmYWNlIGlzc3VlXG4gICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ3Bhc3N3b3JkJywgXCJQYXNzd29yZCBSZXF1aXJlZFwiKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9vblBhc3N3b3JkUmVxdWlyZWQodGhpcyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJhdXRoIGNoYWxsZW5nZVwiLCAxNikpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgIC8vIFRPRE8oZGlyZWN0eG1hbjEyKTogbWFrZSBnZW5ERVMgbm90IHJlcXVpcmUgYW4gQXJyYXlcbiAgICAgICAgICAgIHZhciBjaGFsbGVuZ2UgPSBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbCh0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcygxNikpO1xuICAgICAgICAgICAgdmFyIHJlc3BvbnNlID0gUkZCLmdlbkRFUyh0aGlzLl9yZmJfcGFzc3dvcmQsIGNoYWxsZW5nZSk7XG4gICAgICAgICAgICB0aGlzLl9zb2NrLnNlbmQocmVzcG9uc2UpO1xuICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoXCJTZWN1cml0eVJlc3VsdFwiKTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9uZWdvdGlhdGVfdGlnaHRfdHVubmVsczogZnVuY3Rpb24gKG51bVR1bm5lbHMpIHtcbiAgICAgICAgICAgIHZhciBjbGllbnRTdXBwb3J0ZWRUdW5uZWxUeXBlcyA9IHtcbiAgICAgICAgICAgICAgICAwOiB7IHZlbmRvcjogJ1RHSFQnLCBzaWduYXR1cmU6ICdOT1RVTk5FTCcgfVxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIHZhciBzZXJ2ZXJTdXBwb3J0ZWRUdW5uZWxUeXBlcyA9IHt9O1xuICAgICAgICAgICAgLy8gcmVjZWl2ZSB0dW5uZWwgY2FwYWJpbGl0aWVzXG4gICAgICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IG51bVR1bm5lbHM7IGkrKykge1xuICAgICAgICAgICAgICAgIHZhciBjYXBfY29kZSA9IHRoaXMuX3NvY2suclFzaGlmdDMyKCk7XG4gICAgICAgICAgICAgICAgdmFyIGNhcF92ZW5kb3IgPSB0aGlzLl9zb2NrLnJRc2hpZnRTdHIoNCk7XG4gICAgICAgICAgICAgICAgdmFyIGNhcF9zaWduYXR1cmUgPSB0aGlzLl9zb2NrLnJRc2hpZnRTdHIoOCk7XG4gICAgICAgICAgICAgICAgc2VydmVyU3VwcG9ydGVkVHVubmVsVHlwZXNbY2FwX2NvZGVdID0geyB2ZW5kb3I6IGNhcF92ZW5kb3IsIHNpZ25hdHVyZTogY2FwX3NpZ25hdHVyZSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBjaG9vc2UgdGhlIG5vdHVubmVsIHR5cGVcbiAgICAgICAgICAgIGlmIChzZXJ2ZXJTdXBwb3J0ZWRUdW5uZWxUeXBlc1swXSkge1xuICAgICAgICAgICAgICAgIGlmIChzZXJ2ZXJTdXBwb3J0ZWRUdW5uZWxUeXBlc1swXS52ZW5kb3IgIT0gY2xpZW50U3VwcG9ydGVkVHVubmVsVHlwZXNbMF0udmVuZG9yIHx8XG4gICAgICAgICAgICAgICAgICAgIHNlcnZlclN1cHBvcnRlZFR1bm5lbFR5cGVzWzBdLnNpZ25hdHVyZSAhPSBjbGllbnRTdXBwb3J0ZWRUdW5uZWxUeXBlc1swXS5zaWduYXR1cmUpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJDbGllbnQncyB0dW5uZWwgdHlwZSBoYWQgdGhlIGluY29ycmVjdCB2ZW5kb3Igb3Igc2lnbmF0dXJlXCIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnNlbmQoWzAsIDAsIDAsIDBdKTsgIC8vIHVzZSBOT1RVTk5FTFxuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTsgLy8gd2FpdCB1bnRpbCB3ZSByZWNlaXZlIHRoZSBzdWIgYXV0aCBjb3VudCB0byBjb250aW51ZVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChcIlNlcnZlciB3YW50ZWQgdHVubmVscywgYnV0IGRvZXNuJ3Qgc3VwcG9ydCB0aGUgbm90dW5uZWwgdHlwZVwiKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBfbmVnb3RpYXRlX3RpZ2h0X2F1dGg6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICghdGhpcy5fcmZiX3RpZ2h0dm5jKSB7ICAvLyBmaXJzdCBwYXNzLCBkbyB0aGUgdHVubmVsIG5lZ290aWF0aW9uXG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwibnVtIHR1bm5lbHNcIiwgNCkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICAgICAgdmFyIG51bVR1bm5lbHMgPSB0aGlzLl9zb2NrLnJRc2hpZnQzMigpO1xuICAgICAgICAgICAgICAgIGlmIChudW1UdW5uZWxzID4gMCAmJiB0aGlzLl9zb2NrLnJRd2FpdChcInR1bm5lbCBjYXBhYmlsaXRpZXNcIiwgMTYgKiBudW1UdW5uZWxzLCA0KSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgICAgIHRoaXMuX3JmYl90aWdodHZuYyA9IHRydWU7XG5cbiAgICAgICAgICAgICAgICBpZiAobnVtVHVubmVscyA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fbmVnb3RpYXRlX3RpZ2h0X3R1bm5lbHMobnVtVHVubmVscyk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTsgIC8vIHdhaXQgdW50aWwgd2UgcmVjZWl2ZSB0aGUgc3ViIGF1dGggdG8gY29udGludWVcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIHNlY29uZCBwYXNzLCBkbyB0aGUgc3ViLWF1dGggbmVnb3RpYXRpb25cbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcInN1YiBhdXRoIGNvdW50XCIsIDQpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgdmFyIHN1YkF1dGhDb3VudCA9IHRoaXMuX3NvY2suclFzaGlmdDMyKCk7XG4gICAgICAgICAgICBpZiAoc3ViQXV0aENvdW50ID09PSAwKSB7ICAvLyBlbXB0eSBzdWItYXV0aCBsaXN0IHJlY2VpdmVkIG1lYW5zICdubyBhdXRoJyBzdWJ0eXBlIHNlbGVjdGVkXG4gICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ1NlY3VyaXR5UmVzdWx0Jyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcInN1YiBhdXRoIGNhcGFiaWxpdGllc1wiLCAxNiAqIHN1YkF1dGhDb3VudCwgNCkpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgIHZhciBjbGllbnRTdXBwb3J0ZWRUeXBlcyA9IHtcbiAgICAgICAgICAgICAgICAnU1REVk5PQVVUSF9fJzogMSxcbiAgICAgICAgICAgICAgICAnU1REVlZOQ0FVVEhfJzogMlxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgdmFyIHNlcnZlclN1cHBvcnRlZFR5cGVzID0gW107XG5cbiAgICAgICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc3ViQXV0aENvdW50OyBpKyspIHtcbiAgICAgICAgICAgICAgICB2YXIgY2FwTnVtID0gdGhpcy5fc29jay5yUXNoaWZ0MzIoKTtcbiAgICAgICAgICAgICAgICB2YXIgY2FwYWJpbGl0aWVzID0gdGhpcy5fc29jay5yUXNoaWZ0U3RyKDEyKTtcbiAgICAgICAgICAgICAgICBzZXJ2ZXJTdXBwb3J0ZWRUeXBlcy5wdXNoKGNhcGFiaWxpdGllcyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZvciAodmFyIGF1dGhUeXBlIGluIGNsaWVudFN1cHBvcnRlZFR5cGVzKSB7XG4gICAgICAgICAgICAgICAgaWYgKHNlcnZlclN1cHBvcnRlZFR5cGVzLmluZGV4T2YoYXV0aFR5cGUpICE9IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suc2VuZChbMCwgMCwgMCwgY2xpZW50U3VwcG9ydGVkVHlwZXNbYXV0aFR5cGVdXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgc3dpdGNoIChhdXRoVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnU1REVk5PQVVUSF9fJzogIC8vIG5vIGF1dGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgnU2VjdXJpdHlSZXN1bHQnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ1NURFZWTkNBVVRIXyc6IC8vIFZOQyBhdXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcmZiX2F1dGhfc2NoZW1lID0gMjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5faW5pdF9tc2coKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJVbnN1cHBvcnRlZCB0aW55IGF1dGggc2NoZW1lOiBcIiArIGF1dGhUeXBlKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJObyBzdXBwb3J0ZWQgc3ViLWF1dGggdHlwZXMhXCIpO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9uZWdvdGlhdGVfYXV0aGVudGljYXRpb246IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHN3aXRjaCAodGhpcy5fcmZiX2F1dGhfc2NoZW1lKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAwOiAgLy8gY29ubmVjdGlvbiBmYWlsZWRcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiYXV0aCByZWFzb25cIiwgNCkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICAgICAgICAgIHZhciBzdHJsZW4gPSB0aGlzLl9zb2NrLnJRc2hpZnQzMigpO1xuICAgICAgICAgICAgICAgICAgICB2YXIgcmVhc29uID0gdGhpcy5fc29jay5yUXNoaWZ0U3RyKHN0cmxlbik7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiQXV0aCBmYWlsdXJlOiBcIiArIHJlYXNvbik7XG5cbiAgICAgICAgICAgICAgICBjYXNlIDE6ICAvLyBubyBhdXRoXG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9yZmJfdmVyc2lvbiA+PSAzLjgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdTZWN1cml0eVJlc3VsdCcpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ0NsaWVudEluaXRpYWxpc2F0aW9uJywgXCJObyBhdXRoIHJlcXVpcmVkXCIpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5faW5pdF9tc2coKTtcblxuICAgICAgICAgICAgICAgIGNhc2UgMjI6ICAvLyBYVlAgYXV0aFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fbmVnb3RpYXRlX3h2cF9hdXRoKCk7XG5cbiAgICAgICAgICAgICAgICBjYXNlIDI6ICAvLyBWTkMgYXV0aGVudGljYXRpb25cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX25lZ290aWF0ZV9zdGRfdm5jX2F1dGgoKTtcblxuICAgICAgICAgICAgICAgIGNhc2UgMTY6ICAvLyBUaWdodFZOQyBTZWN1cml0eSBUeXBlXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9uZWdvdGlhdGVfdGlnaHRfYXV0aCgpO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJVbnN1cHBvcnRlZCBhdXRoIHNjaGVtZTogXCIgKyB0aGlzLl9yZmJfYXV0aF9zY2hlbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIF9oYW5kbGVfc2VjdXJpdHlfcmVzdWx0OiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoJ1ZOQyBhdXRoIHJlc3BvbnNlICcsIDQpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgc3dpdGNoICh0aGlzLl9zb2NrLnJRc2hpZnQzMigpKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAwOiAgLy8gT0tcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ0NsaWVudEluaXRpYWxpc2F0aW9uJywgJ0F1dGhlbnRpY2F0aW9uIE9LJyk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9pbml0X21zZygpO1xuICAgICAgICAgICAgICAgIGNhc2UgMTogIC8vIGZhaWxlZFxuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcmZiX3ZlcnNpb24gPj0gMy44KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB2YXIgbGVuZ3RoID0gdGhpcy5fc29jay5yUXNoaWZ0MzIoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlNlY3VyaXR5UmVzdWx0IHJlYXNvblwiLCBsZW5ndGgsIDgpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgdmFyIHJlYXNvbiA9IHRoaXMuX3NvY2suclFzaGlmdFN0cihsZW5ndGgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwocmVhc29uKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiQXV0aGVudGljYXRpb24gZmFpbHVyZVwiKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgY2FzZSAyOlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChcIlRvbyBtYW55IGF1dGggYXR0ZW1wdHNcIik7XG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJVbmtub3duIFNlY3VyaXR5UmVzdWx0XCIpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIF9uZWdvdGlhdGVfc2VydmVyX2luaXQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcInNlcnZlciBpbml0aWFsaXphdGlvblwiLCAyNCkpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgIC8qIFNjcmVlbiBzaXplICovXG4gICAgICAgICAgICB0aGlzLl9mYl93aWR0aCAgPSB0aGlzLl9zb2NrLnJRc2hpZnQxNigpO1xuICAgICAgICAgICAgdGhpcy5fZmJfaGVpZ2h0ID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgIHRoaXMuX2Rlc3RCdWZmID0gbmV3IFVpbnQ4QXJyYXkodGhpcy5fZmJfd2lkdGggKiB0aGlzLl9mYl9oZWlnaHQgKiA0KTtcblxuICAgICAgICAgICAgLyogUElYRUxfRk9STUFUICovXG4gICAgICAgICAgICB2YXIgYnBwICAgICAgICAgPSB0aGlzLl9zb2NrLnJRc2hpZnQ4KCk7XG4gICAgICAgICAgICB2YXIgZGVwdGggICAgICAgPSB0aGlzLl9zb2NrLnJRc2hpZnQ4KCk7XG4gICAgICAgICAgICB2YXIgYmlnX2VuZGlhbiAgPSB0aGlzLl9zb2NrLnJRc2hpZnQ4KCk7XG4gICAgICAgICAgICB2YXIgdHJ1ZV9jb2xvciAgPSB0aGlzLl9zb2NrLnJRc2hpZnQ4KCk7XG5cbiAgICAgICAgICAgIHZhciByZWRfbWF4ICAgICA9IHRoaXMuX3NvY2suclFzaGlmdDE2KCk7XG4gICAgICAgICAgICB2YXIgZ3JlZW5fbWF4ICAgPSB0aGlzLl9zb2NrLnJRc2hpZnQxNigpO1xuICAgICAgICAgICAgdmFyIGJsdWVfbWF4ICAgID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgIHZhciByZWRfc2hpZnQgICA9IHRoaXMuX3NvY2suclFzaGlmdDgoKTtcbiAgICAgICAgICAgIHZhciBncmVlbl9zaGlmdCA9IHRoaXMuX3NvY2suclFzaGlmdDgoKTtcbiAgICAgICAgICAgIHZhciBibHVlX3NoaWZ0ICA9IHRoaXMuX3NvY2suclFzaGlmdDgoKTtcbiAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwQnl0ZXMoMyk7ICAvLyBwYWRkaW5nXG5cbiAgICAgICAgICAgIC8vIE5CKGRpcmVjdHhtYW4xMik6IHdlIGRvbid0IHdhbnQgdG8gY2FsbCBhbnkgY2FsbGJhY2tzIG9yIHByaW50IG1lc3NhZ2VzIHVudGlsXG4gICAgICAgICAgICAvLyAgICAgICAgICAgICAgICAgICAqYWZ0ZXIqIHdlJ3JlIHBhc3QgdGhlIHBvaW50IHdoZXJlIHdlIGNvdWxkIGJhY2t0cmFja1xuXG4gICAgICAgICAgICAvKiBDb25uZWN0aW9uIG5hbWUvdGl0bGUgKi9cbiAgICAgICAgICAgIHZhciBuYW1lX2xlbmd0aCA9IHRoaXMuX3NvY2suclFzaGlmdDMyKCk7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoJ3NlcnZlciBpbml0IG5hbWUnLCBuYW1lX2xlbmd0aCwgMjQpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgdGhpcy5fZmJfbmFtZSA9IFV0aWwuZGVjb2RlVVRGOCh0aGlzLl9zb2NrLnJRc2hpZnRTdHIobmFtZV9sZW5ndGgpKTtcblxuICAgICAgICAgICAgaWYgKHRoaXMuX3JmYl90aWdodHZuYykge1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdCgnVGlnaHRWTkMgZXh0ZW5kZWQgc2VydmVyIGluaXQgaGVhZGVyJywgOCwgMjQgKyBuYW1lX2xlbmd0aCkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICAgICAgLy8gSW4gVGlnaHRWTkMgbW9kZSwgU2VydmVySW5pdCBtZXNzYWdlIGlzIGV4dGVuZGVkXG4gICAgICAgICAgICAgICAgdmFyIG51bVNlcnZlck1lc3NhZ2VzID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgICAgICB2YXIgbnVtQ2xpZW50TWVzc2FnZXMgPSB0aGlzLl9zb2NrLnJRc2hpZnQxNigpO1xuICAgICAgICAgICAgICAgIHZhciBudW1FbmNvZGluZ3MgPSB0aGlzLl9zb2NrLnJRc2hpZnQxNigpO1xuICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwQnl0ZXMoMik7ICAvLyBwYWRkaW5nXG5cbiAgICAgICAgICAgICAgICB2YXIgdG90YWxNZXNzYWdlc0xlbmd0aCA9IChudW1TZXJ2ZXJNZXNzYWdlcyArIG51bUNsaWVudE1lc3NhZ2VzICsgbnVtRW5jb2RpbmdzKSAqIDE2O1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdCgnVGlnaHRWTkMgZXh0ZW5kZWQgc2VydmVyIGluaXQgaGVhZGVyJywgdG90YWxNZXNzYWdlc0xlbmd0aCwgMzIgKyBuYW1lX2xlbmd0aCkpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgICAgICAvLyB3ZSBkb24ndCBhY3R1YWxseSBkbyBhbnl0aGluZyB3aXRoIHRoZSBjYXBhYmlsaXR5IGluZm9ybWF0aW9uIHRoYXQgVElHSFQgc2VuZHMsXG4gICAgICAgICAgICAgICAgLy8gc28gd2UganVzdCBza2lwIHRoZSBhbGwgb2YgdGhpcy5cblxuICAgICAgICAgICAgICAgIC8vIFRJR0hUIHNlcnZlciBtZXNzYWdlIGNhcGFiaWxpdGllc1xuICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwQnl0ZXMoMTYgKiBudW1TZXJ2ZXJNZXNzYWdlcyk7XG5cbiAgICAgICAgICAgICAgICAvLyBUSUdIVCBjbGllbnQgbWVzc2FnZSBjYXBhYmlsaXRpZXNcbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKDE2ICogbnVtQ2xpZW50TWVzc2FnZXMpO1xuXG4gICAgICAgICAgICAgICAgLy8gVElHSFQgZW5jb2RpbmcgY2FwYWJpbGl0aWVzXG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygxNiAqIG51bUVuY29kaW5ncyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIE5CKGRpcmVjdHhtYW4xMik6IHRoZXNlIGFyZSBkb3duIGhlcmUgc28gdGhhdCB3ZSBkb24ndCBydW4gdGhlbSBtdWx0aXBsZSB0aW1lc1xuICAgICAgICAgICAgLy8gICAgICAgICAgICAgICAgICAgaWYgd2UgYmFja3RyYWNrXG4gICAgICAgICAgICBVdGlsLkluZm8oXCJTY3JlZW46IFwiICsgdGhpcy5fZmJfd2lkdGggKyBcInhcIiArIHRoaXMuX2ZiX2hlaWdodCArXG4gICAgICAgICAgICAgICAgICAgICAgXCIsIGJwcDogXCIgKyBicHAgKyBcIiwgZGVwdGg6IFwiICsgZGVwdGggK1xuICAgICAgICAgICAgICAgICAgICAgIFwiLCBiaWdfZW5kaWFuOiBcIiArIGJpZ19lbmRpYW4gK1xuICAgICAgICAgICAgICAgICAgICAgIFwiLCB0cnVlX2NvbG9yOiBcIiArIHRydWVfY29sb3IgK1xuICAgICAgICAgICAgICAgICAgICAgIFwiLCByZWRfbWF4OiBcIiArIHJlZF9tYXggK1xuICAgICAgICAgICAgICAgICAgICAgIFwiLCBncmVlbl9tYXg6IFwiICsgZ3JlZW5fbWF4ICtcbiAgICAgICAgICAgICAgICAgICAgICBcIiwgYmx1ZV9tYXg6IFwiICsgYmx1ZV9tYXggK1xuICAgICAgICAgICAgICAgICAgICAgIFwiLCByZWRfc2hpZnQ6IFwiICsgcmVkX3NoaWZ0ICtcbiAgICAgICAgICAgICAgICAgICAgICBcIiwgZ3JlZW5fc2hpZnQ6IFwiICsgZ3JlZW5fc2hpZnQgK1xuICAgICAgICAgICAgICAgICAgICAgIFwiLCBibHVlX3NoaWZ0OiBcIiArIGJsdWVfc2hpZnQpO1xuXG4gICAgICAgICAgICBpZiAoYmlnX2VuZGlhbiAhPT0gMCkge1xuICAgICAgICAgICAgICAgIFV0aWwuV2FybihcIlNlcnZlciBuYXRpdmUgZW5kaWFuIGlzIG5vdCBsaXR0bGUgZW5kaWFuXCIpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAocmVkX3NoaWZ0ICE9PSAxNikge1xuICAgICAgICAgICAgICAgIFV0aWwuV2FybihcIlNlcnZlciBuYXRpdmUgcmVkLXNoaWZ0IGlzIG5vdCAxNlwiKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGJsdWVfc2hpZnQgIT09IDApIHtcbiAgICAgICAgICAgICAgICBVdGlsLldhcm4oXCJTZXJ2ZXIgbmF0aXZlIGJsdWUtc2hpZnQgaXMgbm90IDBcIik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIHdlJ3JlIHBhc3QgdGhlIHBvaW50IHdoZXJlIHdlIGNvdWxkIGJhY2t0cmFjaywgc28gaXQncyBzYWZlIHRvIGNhbGwgdGhpc1xuICAgICAgICAgICAgdGhpcy5fb25EZXNrdG9wTmFtZSh0aGlzLCB0aGlzLl9mYl9uYW1lKTtcblxuICAgICAgICAgICAgaWYgKHRoaXMuX3RydWVfY29sb3IgJiYgdGhpcy5fZmJfbmFtZSA9PT0gXCJJbnRlbChyKSBBTVQgS1ZNXCIpIHtcbiAgICAgICAgICAgICAgICBVdGlsLldhcm4oXCJJbnRlbCBBTVQgS1ZNIG9ubHkgc3VwcG9ydHMgOC8xNiBiaXQgZGVwdGhzLiAgRGlzYWJsaW5nIHRydWUgY29sb3JcIik7XG4gICAgICAgICAgICAgICAgdGhpcy5fdHJ1ZV9jb2xvciA9IGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aGlzLl9kaXNwbGF5LnNldF90cnVlX2NvbG9yKHRoaXMuX3RydWVfY29sb3IpO1xuICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5yZXNpemUodGhpcy5fZmJfd2lkdGgsIHRoaXMuX2ZiX2hlaWdodCk7XG4gICAgICAgICAgICB0aGlzLl9vbkZCUmVzaXplKHRoaXMsIHRoaXMuX2ZiX3dpZHRoLCB0aGlzLl9mYl9oZWlnaHQpO1xuICAgICAgICAgICAgdGhpcy5fa2V5Ym9hcmQuZ3JhYigpO1xuICAgICAgICAgICAgdGhpcy5fbW91c2UuZ3JhYigpO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5fdHJ1ZV9jb2xvcikge1xuICAgICAgICAgICAgICAgIHRoaXMuX2ZiX0JwcCA9IDQ7XG4gICAgICAgICAgICAgICAgdGhpcy5fZmJfZGVwdGggPSAzO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9mYl9CcHAgPSAxO1xuICAgICAgICAgICAgICAgIHRoaXMuX2ZiX2RlcHRoID0gMTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLnBpeGVsRm9ybWF0KHRoaXMuX3NvY2ssIHRoaXMuX2ZiX0JwcCwgdGhpcy5fZmJfZGVwdGgsIHRoaXMuX3RydWVfY29sb3IpO1xuICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmNsaWVudEVuY29kaW5ncyh0aGlzLl9zb2NrLCB0aGlzLl9lbmNvZGluZ3MsIHRoaXMuX2xvY2FsX2N1cnNvciwgdGhpcy5fdHJ1ZV9jb2xvcik7XG4gICAgICAgICAgICBSRkIubWVzc2FnZXMuZmJVcGRhdGVSZXF1ZXN0cyh0aGlzLl9zb2NrLCBmYWxzZSwgdGhpcy5fZGlzcGxheS5nZXRDbGVhbkRpcnR5UmVzZXQoKSwgdGhpcy5fZmJfd2lkdGgsIHRoaXMuX2ZiX2hlaWdodCk7XG5cbiAgICAgICAgICAgIHRoaXMuX3RpbWluZy5mYnVfcnRfc3RhcnQgPSAobmV3IERhdGUoKSkuZ2V0VGltZSgpO1xuICAgICAgICAgICAgdGhpcy5fdGltaW5nLnBpeGVscyA9IDA7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9lbmNyeXB0KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ25vcm1hbCcsICdDb25uZWN0ZWQgKGVuY3J5cHRlZCkgdG86ICcgKyB0aGlzLl9mYl9uYW1lKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ25vcm1hbCcsICdDb25uZWN0ZWQgKHVuZW5jcnlwdGVkKSB0bzogJyArIHRoaXMuX2ZiX25hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2luaXRfbXNnOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBzd2l0Y2ggKHRoaXMuX3JmYl9zdGF0ZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgJ1Byb3RvY29sVmVyc2lvbic6XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9uZWdvdGlhdGVfcHJvdG9jb2xfdmVyc2lvbigpO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnU2VjdXJpdHknOlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fbmVnb3RpYXRlX3NlY3VyaXR5KCk7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdBdXRoZW50aWNhdGlvbic6XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9uZWdvdGlhdGVfYXV0aGVudGljYXRpb24oKTtcblxuICAgICAgICAgICAgICAgIGNhc2UgJ1NlY3VyaXR5UmVzdWx0JzpcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2hhbmRsZV9zZWN1cml0eV9yZXN1bHQoKTtcblxuICAgICAgICAgICAgICAgIGNhc2UgJ0NsaWVudEluaXRpYWxpc2F0aW9uJzpcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5zZW5kKFt0aGlzLl9zaGFyZWQgPyAxIDogMF0pOyAvLyBDbGllbnRJbml0aWFsaXNhdGlvblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgnU2VydmVySW5pdGlhbGlzYXRpb24nLCBcIkF1dGhlbnRpY2F0aW9uIE9LXCIpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcblxuICAgICAgICAgICAgICAgIGNhc2UgJ1NlcnZlckluaXRpYWxpc2F0aW9uJzpcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX25lZ290aWF0ZV9zZXJ2ZXJfaW5pdCgpO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJVbmtub3duIHN0YXRlOiBcIiArIHRoaXMuX3JmYl9zdGF0ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2hhbmRsZV9zZXRfY29sb3VyX21hcF9tc2c6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIFV0aWwuRGVidWcoXCJTZXRDb2xvck1hcEVudHJpZXNcIik7XG4gICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcDgoKTsgIC8vIFBhZGRpbmdcblxuICAgICAgICAgICAgdmFyIGZpcnN0X2NvbG91ciA9IHRoaXMuX3NvY2suclFzaGlmdDE2KCk7XG4gICAgICAgICAgICB2YXIgbnVtX2NvbG91cnMgPSB0aGlzLl9zb2NrLnJRc2hpZnQxNigpO1xuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KCdTZXRDb2xvck1hcEVudHJpZXMnLCBudW1fY29sb3VycyAqIDYsIDYpKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgICAgICAgICBmb3IgKHZhciBjID0gMDsgYyA8IG51bV9jb2xvdXJzOyBjKyspIHtcbiAgICAgICAgICAgICAgICB2YXIgcmVkID0gcGFyc2VJbnQodGhpcy5fc29jay5yUXNoaWZ0MTYoKSAvIDI1NiwgMTApO1xuICAgICAgICAgICAgICAgIHZhciBncmVlbiA9IHBhcnNlSW50KHRoaXMuX3NvY2suclFzaGlmdDE2KCkgLyAyNTYsIDEwKTtcbiAgICAgICAgICAgICAgICB2YXIgYmx1ZSA9IHBhcnNlSW50KHRoaXMuX3NvY2suclFzaGlmdDE2KCkgLyAyNTYsIDEwKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LnNldF9jb2xvdXJNYXAoW2JsdWUsIGdyZWVuLCByZWRdLCBmaXJzdF9jb2xvdXIgKyBjKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFV0aWwuRGVidWcoXCJjb2xvdXJNYXA6IFwiICsgdGhpcy5fZGlzcGxheS5nZXRfY29sb3VyTWFwKCkpO1xuICAgICAgICAgICAgVXRpbC5JbmZvKFwiUmVnaXN0ZXJlZCBcIiArIG51bV9jb2xvdXJzICsgXCIgY29sb3VyTWFwIGVudHJpZXNcIik7XG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9oYW5kbGVfc2VydmVyX2N1dF90ZXh0OiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBVdGlsLkRlYnVnKFwiU2VydmVyQ3V0VGV4dFwiKTtcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlNlcnZlckN1dFRleHQgaGVhZGVyXCIsIDcsIDEpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygzKTsgIC8vIFBhZGRpbmdcbiAgICAgICAgICAgIHZhciBsZW5ndGggPSB0aGlzLl9zb2NrLnJRc2hpZnQzMigpO1xuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiU2VydmVyQ3V0VGV4dFwiLCBsZW5ndGgsIDgpKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgICAgICAgICB2YXIgdGV4dCA9IHRoaXMuX3NvY2suclFzaGlmdFN0cihsZW5ndGgpO1xuICAgICAgICAgICAgdGhpcy5fb25DbGlwYm9hcmQodGhpcywgdGV4dCk7XG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9oYW5kbGVfc2VydmVyX2ZlbmNlX21zZzogZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJTZXJ2ZXJGZW5jZSBoZWFkZXJcIiwgOCwgMSkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKDMpOyAvLyBQYWRkaW5nXG4gICAgICAgICAgICB2YXIgZmxhZ3MgPSB0aGlzLl9zb2NrLnJRc2hpZnQzMigpO1xuICAgICAgICAgICAgdmFyIGxlbmd0aCA9IHRoaXMuX3NvY2suclFzaGlmdDgoKTtcblxuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiU2VydmVyRmVuY2UgcGF5bG9hZFwiLCBsZW5ndGgsIDkpKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgICAgICAgICBpZiAobGVuZ3RoID4gNjQpIHtcbiAgICAgICAgICAgICAgICBVdGlsLldhcm4oXCJCYWQgcGF5bG9hZCBsZW5ndGggKFwiICsgbGVuZ3RoICsgXCIpIGluIGZlbmNlIHJlc3BvbnNlXCIpO1xuICAgICAgICAgICAgICAgIGxlbmd0aCA9IDY0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YXIgcGF5bG9hZCA9IHRoaXMuX3NvY2suclFzaGlmdFN0cihsZW5ndGgpO1xuXG4gICAgICAgICAgICB0aGlzLl9zdXBwb3J0c0ZlbmNlID0gdHJ1ZTtcblxuICAgICAgICAgICAgLypcbiAgICAgICAgICAgICAqIEZlbmNlIGZsYWdzXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogICgxPDwwKSAgLSBCbG9ja0JlZm9yZVxuICAgICAgICAgICAgICogICgxPDwxKSAgLSBCbG9ja0FmdGVyXG4gICAgICAgICAgICAgKiAgKDE8PDIpICAtIFN5bmNOZXh0XG4gICAgICAgICAgICAgKiAgKDE8PDMxKSAtIFJlcXVlc3RcbiAgICAgICAgICAgICAqL1xuXG4gICAgICAgICAgICBpZiAoIShmbGFncyAmICgxPDwzMSkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJVbmV4cGVjdGVkIGZlbmNlIHJlc3BvbnNlXCIpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBGaWx0ZXIgb3V0IHVuc3VwcG9ydGVkIGZsYWdzXG4gICAgICAgICAgICAvLyBGSVhNRTogc3VwcG9ydCBzeW5jTmV4dFxuICAgICAgICAgICAgZmxhZ3MgJj0gKDE8PDApIHwgKDE8PDEpO1xuXG4gICAgICAgICAgICAvLyBCbG9ja0JlZm9yZSBhbmQgQmxvY2tBZnRlciBhcmUgYXV0b21hdGljYWxseSBoYW5kbGVkIGJ5XG4gICAgICAgICAgICAvLyB0aGUgZmFjdCB0aGF0IHdlIHByb2Nlc3MgZWFjaCBpbmNvbWluZyBtZXNzYWdlXG4gICAgICAgICAgICAvLyBzeW5jaHJvbnVvc2x5LlxuICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmNsaWVudEZlbmNlKHRoaXMuX3NvY2ssIGZsYWdzLCBwYXlsb2FkKTtcblxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2hhbmRsZV94dnBfbXNnOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJYVlAgdmVyc2lvbiBhbmQgbWVzc2FnZVwiLCAzLCAxKSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwOCgpOyAgLy8gUGFkZGluZ1xuICAgICAgICAgICAgdmFyIHh2cF92ZXIgPSB0aGlzLl9zb2NrLnJRc2hpZnQ4KCk7XG4gICAgICAgICAgICB2YXIgeHZwX21zZyA9IHRoaXMuX3NvY2suclFzaGlmdDgoKTtcblxuICAgICAgICAgICAgc3dpdGNoICh4dnBfbXNnKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAwOiAgLy8gWFZQX0ZBSUxcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUodGhpcy5fcmZiX3N0YXRlLCBcIk9wZXJhdGlvbiBGYWlsZWRcIik7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgMTogIC8vIFhWUF9JTklUXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3JmYl94dnBfdmVyID0geHZwX3ZlcjtcbiAgICAgICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiWFZQIGV4dGVuc2lvbnMgZW5hYmxlZCAodmVyc2lvbiBcIiArIHRoaXMuX3JmYl94dnBfdmVyICsgXCIpXCIpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9vblh2cEluaXQodGhpcy5fcmZiX3h2cF92ZXIpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9mYWlsKFwiRGlzY29ubmVjdGVkOiBpbGxlZ2FsIHNlcnZlciBYVlAgbWVzc2FnZSBcIiArIHh2cF9tc2cpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2NoZWNrX2RyYXdfY29tcGxldGVkOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX2Rpc3BsYXkuX3JlbmRlclEubGVuZ3RoID09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5mYlVwZGF0ZVJlcXVlc3RzKHRoaXMuX3NvY2ssXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9lbmFibGVkQ29udGludW91c1VwZGF0ZXMsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmdldENsZWFuRGlydHlSZXNldCgpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmJfd2lkdGgsIHRoaXMuX2ZiX2hlaWdodCk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKHRoaXMuX2NoZWNrX2RyYXdfY29tcGxldGVkLmJpbmQodGhpcykpO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9ub3JtYWxfbXNnOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB2YXIgbXNnX3R5cGU7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9GQlUucmVjdHMgPiAwKSB7XG4gICAgICAgICAgICAgICAgbXNnX3R5cGUgPSAwO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBtc2dfdHlwZSA9IHRoaXMuX3NvY2suclFzaGlmdDgoKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3dpdGNoIChtc2dfdHlwZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgMDogIC8vIEZyYW1lYnVmZmVyVXBkYXRlXG4gICAgICAgICAgICAgICAgICAgIHZhciByZXQgPSB0aGlzLl9mcmFtZWJ1ZmZlclVwZGF0ZSgpO1xuICAgICAgICAgICAgICAgICAgICBpZiAocmV0KSB7XG5cdFx0XHQgdGhpcy5fY2hlY2tfZHJhd19jb21wbGV0ZWQoKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmV0O1xuXG4gICAgICAgICAgICAgICAgY2FzZSAxOiAgLy8gU2V0Q29sb3JNYXBFbnRyaWVzXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9oYW5kbGVfc2V0X2NvbG91cl9tYXBfbXNnKCk7XG5cbiAgICAgICAgICAgICAgICBjYXNlIDI6ICAvLyBCZWxsXG4gICAgICAgICAgICAgICAgICAgIFV0aWwuRGVidWcoXCJCZWxsXCIpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9vbkJlbGwodGhpcyk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAzOiAgLy8gU2VydmVyQ3V0VGV4dFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5faGFuZGxlX3NlcnZlcl9jdXRfdGV4dCgpO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAxNTA6IC8vIEVuZE9mQ29udGludW91c1VwZGF0ZXNcbiAgICAgICAgICAgICAgICAgICAgdmFyIGZpcnN0ID0gISh0aGlzLl9zdXBwb3J0c0NvbnRpbnVvdXNVcGRhdGVzKTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc3VwcG9ydHNDb250aW51b3VzVXBkYXRlcyA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2VuYWJsZWRDb250aW51b3VzVXBkYXRlcyA9IGZhbHNlO1xuICAgICAgICAgICAgICAgICAgICBpZiAoZmlyc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2VuYWJsZWRDb250aW51b3VzVXBkYXRlcyA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVDb250aW51b3VzVXBkYXRlcygpO1xuICAgICAgICAgICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiRW5hYmxpbmcgY29udGludW91cyB1cGRhdGVzLlwiKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIEZJWE1FOiBXZSBuZWVkIHRvIHNlbmQgYSBmcmFtZWJ1ZmZlcnVwZGF0ZXJlcXVlc3QgaGVyZVxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gaWYgd2UgYWRkIHN1cHBvcnQgZm9yIHR1cm5pbmcgb2ZmIGNvbnRpbnVvdXMgdXBkYXRlc1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAyNDg6IC8vIFNlcnZlckZlbmNlXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9oYW5kbGVfc2VydmVyX2ZlbmNlX21zZygpO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAyNTA6ICAvLyBYVlBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2hhbmRsZV94dnBfbXNnKCk7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9mYWlsKFwiRGlzY29ubmVjdGVkOiBpbGxlZ2FsIHNlcnZlciBtZXNzYWdlIHR5cGUgXCIgKyBtc2dfdHlwZSk7XG4gICAgICAgICAgICAgICAgICAgIFV0aWwuRGVidWcoXCJzb2NrLnJRc2xpY2UoMCwgMzApOiBcIiArIHRoaXMuX3NvY2suclFzbGljZSgwLCAzMCkpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBfZnJhbWVidWZmZXJVcGRhdGU6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHZhciByZXQgPSB0cnVlO1xuICAgICAgICAgICAgdmFyIG5vdztcblxuICAgICAgICAgICAgaWYgKHRoaXMuX0ZCVS5yZWN0cyA9PT0gMCkge1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIkZCVSBoZWFkZXJcIiwgMywgMSkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXA4KCk7ICAvLyBQYWRkaW5nXG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLnJlY3RzID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgPSAwO1xuICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5jdXJfZmJ1ID0gMDtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fdGltaW5nLmZidV9ydF9zdGFydCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgbm93ID0gKG5ldyBEYXRlKCkpLmdldFRpbWUoKTtcbiAgICAgICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiRmlyc3QgRkJVIGxhdGVuY3k6IFwiICsgKG5vdyAtIHRoaXMuX3RpbWluZy5mYnVfcnRfc3RhcnQpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHdoaWxlICh0aGlzLl9GQlUucmVjdHMgPiAwKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3JmYl9zdGF0ZSAhPT0gXCJub3JtYWxcIikgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIkZCVVwiLCB0aGlzLl9GQlUuYnl0ZXMpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9GQlUuYnl0ZXMgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwicmVjdCBoZWFkZXJcIiwgMTIpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgICAgICAgICAvKiBOZXcgRnJhbWVidWZmZXJVcGRhdGUgKi9cblxuICAgICAgICAgICAgICAgICAgICB2YXIgaGRyID0gdGhpcy5fc29jay5yUXNoaWZ0Qnl0ZXMoMTIpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUueCAgICAgICAgPSAoaGRyWzBdIDw8IDgpICsgaGRyWzFdO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUueSAgICAgICAgPSAoaGRyWzJdIDw8IDgpICsgaGRyWzNdO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUud2lkdGggICAgPSAoaGRyWzRdIDw8IDgpICsgaGRyWzVdO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuaGVpZ2h0ICAgPSAoaGRyWzZdIDw8IDgpICsgaGRyWzddO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuZW5jb2RpbmcgPSBwYXJzZUludCgoaGRyWzhdIDw8IDI0KSArIChoZHJbOV0gPDwgMTYpICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKGhkclsxMF0gPDwgOCkgKyBoZHJbMTFdLCAxMCk7XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fb25GQlVSZWNlaXZlKHRoaXMsXG4gICAgICAgICAgICAgICAgICAgICAgICB7J3gnOiB0aGlzLl9GQlUueCwgJ3knOiB0aGlzLl9GQlUueSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAnd2lkdGgnOiB0aGlzLl9GQlUud2lkdGgsICdoZWlnaHQnOiB0aGlzLl9GQlUuaGVpZ2h0LFxuICAgICAgICAgICAgICAgICAgICAgICAgICdlbmNvZGluZyc6IHRoaXMuX0ZCVS5lbmNvZGluZyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAnZW5jb2RpbmdOYW1lJzogdGhpcy5fZW5jTmFtZXNbdGhpcy5fRkJVLmVuY29kaW5nXX0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghdGhpcy5fZW5jTmFtZXNbdGhpcy5fRkJVLmVuY29kaW5nXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmFpbChcIkRpc2Nvbm5lY3RlZDogdW5zdXBwb3J0ZWQgZW5jb2RpbmcgXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuZW5jb2RpbmcpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhpcy5fdGltaW5nLmxhc3RfZmJ1ID0gKG5ldyBEYXRlKCkpLmdldFRpbWUoKTtcblxuICAgICAgICAgICAgICAgIHJldCA9IHRoaXMuX2VuY0hhbmRsZXJzW3RoaXMuX0ZCVS5lbmNvZGluZ10oKTtcblxuICAgICAgICAgICAgICAgIG5vdyA9IChuZXcgRGF0ZSgpKS5nZXRUaW1lKCk7XG4gICAgICAgICAgICAgICAgdGhpcy5fdGltaW5nLmN1cl9mYnUgKz0gKG5vdyAtIHRoaXMuX3RpbWluZy5sYXN0X2ZidSk7XG5cbiAgICAgICAgICAgICAgICBpZiAocmV0KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2VuY1N0YXRzW3RoaXMuX0ZCVS5lbmNvZGluZ11bMF0rKztcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZW5jU3RhdHNbdGhpcy5fRkJVLmVuY29kaW5nXVsxXSsrO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl90aW1pbmcucGl4ZWxzICs9IHRoaXMuX0ZCVS53aWR0aCAqIHRoaXMuX0ZCVS5oZWlnaHQ7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3RpbWluZy5waXhlbHMgPj0gKHRoaXMuX2ZiX3dpZHRoICogdGhpcy5fZmJfaGVpZ2h0KSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoKHRoaXMuX0ZCVS53aWR0aCA9PT0gdGhpcy5fZmJfd2lkdGggJiYgdGhpcy5fRkJVLmhlaWdodCA9PT0gdGhpcy5fZmJfaGVpZ2h0KSB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdGltaW5nLmZidV9ydF9zdGFydCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5mdWxsX2ZidV90b3RhbCArPSB0aGlzLl90aW1pbmcuY3VyX2ZidTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5mdWxsX2ZidV9jbnQrKztcbiAgICAgICAgICAgICAgICAgICAgICAgIFV0aWwuSW5mbyhcIlRpbWluZyBvZiBmdWxsIEZCVSwgY3VycjogXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5jdXJfZmJ1ICsgXCIsIHRvdGFsOiBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdGltaW5nLmZ1bGxfZmJ1X3RvdGFsICsgXCIsIGNudDogXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5mdWxsX2ZidV9jbnQgKyBcIiwgYXZnOiBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKHRoaXMuX3RpbWluZy5mdWxsX2ZidV90b3RhbCAvIHRoaXMuX3RpbWluZy5mdWxsX2ZidV9jbnQpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl90aW1pbmcuZmJ1X3J0X3N0YXJ0ID4gMCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdmFyIGZidV9ydF9kaWZmID0gbm93IC0gdGhpcy5fdGltaW5nLmZidV9ydF9zdGFydDtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5mYnVfcnRfdG90YWwgKz0gZmJ1X3J0X2RpZmY7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl90aW1pbmcuZmJ1X3J0X2NudCsrO1xuICAgICAgICAgICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiZnVsbCBGQlUgcm91bmQtdHJpcCwgY3VyOiBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZmJ1X3J0X2RpZmYgKyBcIiwgdG90YWw6IFwiICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl90aW1pbmcuZmJ1X3J0X3RvdGFsICsgXCIsIGNudDogXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5mYnVfcnRfY250ICsgXCIsIGF2ZzogXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICh0aGlzLl90aW1pbmcuZmJ1X3J0X3RvdGFsIC8gdGhpcy5fdGltaW5nLmZidV9ydF9jbnQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5mYnVfcnRfc3RhcnQgPSAwO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFyZXQpIHsgcmV0dXJuIHJldDsgfSAgLy8gbmVlZCBtb3JlIGRhdGFcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhpcy5fb25GQlVDb21wbGV0ZSh0aGlzLFxuICAgICAgICAgICAgICAgICAgICB7J3gnOiB0aGlzLl9GQlUueCwgJ3knOiB0aGlzLl9GQlUueSxcbiAgICAgICAgICAgICAgICAgICAgICd3aWR0aCc6IHRoaXMuX0ZCVS53aWR0aCwgJ2hlaWdodCc6IHRoaXMuX0ZCVS5oZWlnaHQsXG4gICAgICAgICAgICAgICAgICAgICAnZW5jb2RpbmcnOiB0aGlzLl9GQlUuZW5jb2RpbmcsXG4gICAgICAgICAgICAgICAgICAgICAnZW5jb2RpbmdOYW1lJzogdGhpcy5fZW5jTmFtZXNbdGhpcy5fRkJVLmVuY29kaW5nXX0pO1xuXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTsgIC8vIFdlIGZpbmlzaGVkIHRoaXMgRkJVXG4gICAgICAgIH0sXG5cbiAgICAgICAgX3VwZGF0ZUNvbnRpbnVvdXNVcGRhdGVzOiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIGlmICghdGhpcy5fZW5hYmxlZENvbnRpbnVvdXNVcGRhdGVzKSB7IHJldHVybjsgfVxuXG4gICAgICAgICAgICBSRkIubWVzc2FnZXMuZW5hYmxlQ29udGludW91c1VwZGF0ZXModGhpcy5fc29jaywgdHJ1ZSwgMCwgMCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9mYl93aWR0aCwgdGhpcy5fZmJfaGVpZ2h0KTtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICBVdGlsLm1ha2VfcHJvcGVydGllcyhSRkIsIFtcbiAgICAgICAgWyd0YXJnZXQnLCAnd28nLCAnZG9tJ10sICAgICAgICAgICAgICAgIC8vIFZOQyBkaXNwbGF5IHJlbmRlcmluZyBDYW52YXMgb2JqZWN0XG4gICAgICAgIFsnZm9jdXNDb250YWluZXInLCAnd28nLCAnZG9tJ10sICAgICAgICAvLyBET00gZWxlbWVudCB0aGF0IGNhcHR1cmVzIGtleWJvYXJkIGlucHV0XG4gICAgICAgIFsnZW5jcnlwdCcsICdydycsICdib29sJ10sICAgICAgICAgICAgICAvLyBVc2UgVExTL1NTTC93c3MgZW5jcnlwdGlvblxuICAgICAgICBbJ3RydWVfY29sb3InLCAncncnLCAnYm9vbCddLCAgICAgICAgICAgLy8gUmVxdWVzdCB0cnVlIGNvbG9yIHBpeGVsIGRhdGFcbiAgICAgICAgWydsb2NhbF9jdXJzb3InLCAncncnLCAnYm9vbCddLCAgICAgICAgIC8vIFJlcXVlc3QgbG9jYWxseSByZW5kZXJlZCBjdXJzb3JcbiAgICAgICAgWydzaGFyZWQnLCAncncnLCAnYm9vbCddLCAgICAgICAgICAgICAgIC8vIFJlcXVlc3Qgc2hhcmVkIG1vZGVcbiAgICAgICAgWyd2aWV3X29ubHknLCAncncnLCAnYm9vbCddLCAgICAgICAgICAgIC8vIERpc2FibGUgY2xpZW50IG1vdXNlL2tleWJvYXJkXG4gICAgICAgIFsneHZwX3Bhc3N3b3JkX3NlcCcsICdydycsICdzdHInXSwgICAgICAvLyBTZXBhcmF0b3IgZm9yIFhWUCBwYXNzd29yZCBmaWVsZHNcbiAgICAgICAgWydkaXNjb25uZWN0VGltZW91dCcsICdydycsICdpbnQnXSwgICAgIC8vIFRpbWUgKHMpIHRvIHdhaXQgZm9yIGRpc2Nvbm5lY3Rpb25cbiAgICAgICAgWyd3c1Byb3RvY29scycsICdydycsICdhcnInXSwgICAgICAgICAgIC8vIFByb3RvY29scyB0byB1c2UgaW4gdGhlIFdlYlNvY2tldCBjb25uZWN0aW9uXG4gICAgICAgIFsncmVwZWF0ZXJJRCcsICdydycsICdzdHInXSwgICAgICAgICAgICAvLyBbVWx0cmFWTkNdIFJlcGVhdGVySUQgdG8gY29ubmVjdCB0b1xuICAgICAgICBbJ3ZpZXdwb3J0RHJhZycsICdydycsICdib29sJ10sICAgICAgICAgLy8gTW92ZSB0aGUgdmlld3BvcnQgb24gbW91c2UgZHJhZ3NcblxuICAgICAgICAvLyBDYWxsYmFjayBmdW5jdGlvbnNcbiAgICAgICAgWydvblVwZGF0ZVN0YXRlJywgJ3J3JywgJ2Z1bmMnXSwgICAgICAgIC8vIG9uVXBkYXRlU3RhdGUocmZiLCBzdGF0ZSwgb2xkc3RhdGUsIHN0YXR1c01zZyk6IFJGQiBzdGF0ZSB1cGRhdGUvY2hhbmdlXG4gICAgICAgIFsnb25QYXNzd29yZFJlcXVpcmVkJywgJ3J3JywgJ2Z1bmMnXSwgICAvLyBvblBhc3N3b3JkUmVxdWlyZWQocmZiKTogVk5DIHBhc3N3b3JkIGlzIHJlcXVpcmVkXG4gICAgICAgIFsnb25DbGlwYm9hcmQnLCAncncnLCAnZnVuYyddLCAgICAgICAgICAvLyBvbkNsaXBib2FyZChyZmIsIHRleHQpOiBSRkIgY2xpcGJvYXJkIGNvbnRlbnRzIHJlY2VpdmVkXG4gICAgICAgIFsnb25CZWxsJywgJ3J3JywgJ2Z1bmMnXSwgICAgICAgICAgICAgICAvLyBvbkJlbGwocmZiKTogUkZCIEJlbGwgbWVzc2FnZSByZWNlaXZlZFxuICAgICAgICBbJ29uRkJVUmVjZWl2ZScsICdydycsICdmdW5jJ10sICAgICAgICAgLy8gb25GQlVSZWNlaXZlKHJmYiwgZmJ1KTogUkZCIEZCVSByZWNlaXZlZCBidXQgbm90IHlldCBwcm9jZXNzZWRcbiAgICAgICAgWydvbkZCVUNvbXBsZXRlJywgJ3J3JywgJ2Z1bmMnXSwgICAgICAgIC8vIG9uRkJVQ29tcGxldGUocmZiLCBmYnUpOiBSRkIgRkJVIHJlY2VpdmVkIGFuZCBwcm9jZXNzZWRcbiAgICAgICAgWydvbkZCUmVzaXplJywgJ3J3JywgJ2Z1bmMnXSwgICAgICAgICAgIC8vIG9uRkJSZXNpemUocmZiLCB3aWR0aCwgaGVpZ2h0KTogZnJhbWUgYnVmZmVyIHJlc2l6ZWRcbiAgICAgICAgWydvbkRlc2t0b3BOYW1lJywgJ3J3JywgJ2Z1bmMnXSwgICAgICAgIC8vIG9uRGVza3RvcE5hbWUocmZiLCBuYW1lKTogZGVza3RvcCBuYW1lIHJlY2VpdmVkXG4gICAgICAgIFsnb25YdnBJbml0JywgJ3J3JywgJ2Z1bmMnXSAgICAgICAgICAgICAvLyBvblh2cEluaXQodmVyc2lvbik6IFhWUCBleHRlbnNpb25zIGFjdGl2ZSBmb3IgdGhpcyBjb25uZWN0aW9uXG4gICAgXSk7XG5cbiAgICBSRkIucHJvdG90eXBlLnNldF9sb2NhbF9jdXJzb3IgPSBmdW5jdGlvbiAoY3Vyc29yKSB7XG4gICAgICAgIGlmICghY3Vyc29yIHx8IChjdXJzb3IgaW4geycwJzogMSwgJ25vJzogMSwgJ2ZhbHNlJzogMX0pKSB7XG4gICAgICAgICAgICB0aGlzLl9sb2NhbF9jdXJzb3IgPSBmYWxzZTtcbiAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuZGlzYWJsZUxvY2FsQ3Vyc29yKCk7IC8vT25seSBzaG93IHNlcnZlci1zaWRlIGN1cnNvclxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKHRoaXMuX2Rpc3BsYXkuZ2V0X2N1cnNvcl91cmkoKSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX2xvY2FsX2N1cnNvciA9IHRydWU7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIFV0aWwuV2FybihcIkJyb3dzZXIgZG9lcyBub3Qgc3VwcG9ydCBsb2NhbCBjdXJzb3JcIik7XG4gICAgICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5kaXNhYmxlTG9jYWxDdXJzb3IoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH07XG5cbiAgICBSRkIucHJvdG90eXBlLmdldF9kaXNwbGF5ID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gdGhpcy5fZGlzcGxheTsgfTtcbiAgICBSRkIucHJvdG90eXBlLmdldF9rZXlib2FyZCA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuIHRoaXMuX2tleWJvYXJkOyB9O1xuICAgIFJGQi5wcm90b3R5cGUuZ2V0X21vdXNlID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gdGhpcy5fbW91c2U7IH07XG5cbiAgICAvLyBDbGFzcyBNZXRob2RzXG4gICAgUkZCLm1lc3NhZ2VzID0ge1xuICAgICAgICBrZXlFdmVudDogZnVuY3Rpb24gKHNvY2ssIGtleXN5bSwgZG93bikge1xuICAgICAgICAgICAgdmFyIGJ1ZmYgPSBzb2NrLl9zUTtcbiAgICAgICAgICAgIHZhciBvZmZzZXQgPSBzb2NrLl9zUWxlbjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXRdID0gNDsgIC8vIG1zZy10eXBlXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDFdID0gZG93bjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAyXSA9IDA7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDNdID0gMDtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA0XSA9IChrZXlzeW0gPj4gMjQpO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA1XSA9IChrZXlzeW0gPj4gMTYpO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA2XSA9IChrZXlzeW0gPj4gOCk7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDddID0ga2V5c3ltO1xuXG4gICAgICAgICAgICBzb2NrLl9zUWxlbiArPSA4O1xuICAgICAgICAgICAgc29jay5mbHVzaCgpO1xuICAgICAgICB9LFxuXG4gICAgICAgIFFFTVVFeHRlbmRlZEtleUV2ZW50OiBmdW5jdGlvbiAoc29jaywga2V5c3ltLCBkb3duLCBrZXljb2RlKSB7XG4gICAgICAgICAgICBmdW5jdGlvbiBnZXRSRkJrZXljb2RlKHh0X3NjYW5jb2RlKSB7XG4gICAgICAgICAgICAgICAgdmFyIHVwcGVyQnl0ZSA9IChrZXljb2RlID4+IDgpO1xuICAgICAgICAgICAgICAgIHZhciBsb3dlckJ5dGUgPSAoa2V5Y29kZSAmIDB4MDBmZik7XG4gICAgICAgICAgICAgICAgaWYgKHVwcGVyQnl0ZSA9PT0gMHhlMCAmJiBsb3dlckJ5dGUgPCAweDdmKSB7XG4gICAgICAgICAgICAgICAgICAgIGxvd2VyQnl0ZSA9IGxvd2VyQnl0ZSB8IDB4ODA7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBsb3dlckJ5dGU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiB4dF9zY2FuY29kZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFyIGJ1ZmYgPSBzb2NrLl9zUTtcbiAgICAgICAgICAgIHZhciBvZmZzZXQgPSBzb2NrLl9zUWxlbjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXRdID0gMjU1OyAvLyBtc2ctdHlwZVxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxXSA9IDA7IC8vIHN1YiBtc2ctdHlwZVxuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDJdID0gKGRvd24gPj4gOCk7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDNdID0gZG93bjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA0XSA9IChrZXlzeW0gPj4gMjQpO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA1XSA9IChrZXlzeW0gPj4gMTYpO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA2XSA9IChrZXlzeW0gPj4gOCk7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDddID0ga2V5c3ltO1xuXG4gICAgICAgICAgICB2YXIgUkZCa2V5Y29kZSA9IGdldFJGQmtleWNvZGUoa2V5Y29kZSk7XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgOF0gPSAoUkZCa2V5Y29kZSA+PiAyNCk7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDldID0gKFJGQmtleWNvZGUgPj4gMTYpO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxMF0gPSAoUkZCa2V5Y29kZSA+PiA4KTtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTFdID0gUkZCa2V5Y29kZTtcblxuICAgICAgICAgICAgc29jay5fc1FsZW4gKz0gMTI7XG4gICAgICAgICAgICBzb2NrLmZsdXNoKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgcG9pbnRlckV2ZW50OiBmdW5jdGlvbiAoc29jaywgeCwgeSwgbWFzaykge1xuICAgICAgICAgICAgdmFyIGJ1ZmYgPSBzb2NrLl9zUTtcbiAgICAgICAgICAgIHZhciBvZmZzZXQgPSBzb2NrLl9zUWxlbjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXRdID0gNTsgLy8gbXNnLXR5cGVcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxXSA9IG1hc2s7XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMl0gPSB4ID4+IDg7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDNdID0geDtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA0XSA9IHkgPj4gODtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNV0gPSB5O1xuXG4gICAgICAgICAgICBzb2NrLl9zUWxlbiArPSA2O1xuICAgICAgICAgICAgc29jay5mbHVzaCgpO1xuICAgICAgICB9LFxuXG4gICAgICAgIC8vIFRPRE8oZGlyZWN0eG1hbjEyKTogbWFrZSB0aGlzIHVuaWNvZGUgY29tcGF0aWJsZT9cbiAgICAgICAgY2xpZW50Q3V0VGV4dDogZnVuY3Rpb24gKHNvY2ssIHRleHQpIHtcbiAgICAgICAgICAgIHZhciBidWZmID0gc29jay5fc1E7XG4gICAgICAgICAgICB2YXIgb2Zmc2V0ID0gc29jay5fc1FsZW47XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0XSA9IDY7IC8vIG1zZy10eXBlXG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMV0gPSAwOyAvLyBwYWRkaW5nXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDJdID0gMDsgLy8gcGFkZGluZ1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAzXSA9IDA7IC8vIHBhZGRpbmdcblxuICAgICAgICAgICAgdmFyIG4gPSB0ZXh0Lmxlbmd0aDtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA0XSA9IG4gPj4gMjQ7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDVdID0gbiA+PiAxNjtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNl0gPSBuID4+IDg7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDddID0gbjtcblxuICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBuOyBpKyspIHtcbiAgICAgICAgICAgICAgICBidWZmW29mZnNldCArIDggKyBpXSA9ICB0ZXh0LmNoYXJDb2RlQXQoaSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHNvY2suX3NRbGVuICs9IDggKyBuO1xuICAgICAgICAgICAgc29jay5mbHVzaCgpO1xuICAgICAgICB9LFxuXG4gICAgICAgIHNldERlc2t0b3BTaXplOiBmdW5jdGlvbiAoc29jaywgd2lkdGgsIGhlaWdodCwgaWQsIGZsYWdzKSB7XG4gICAgICAgICAgICB2YXIgYnVmZiA9IHNvY2suX3NRO1xuICAgICAgICAgICAgdmFyIG9mZnNldCA9IHNvY2suX3NRbGVuO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldF0gPSAyNTE7ICAgICAgICAgICAgICAvLyBtc2ctdHlwZVxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxXSA9IDA7ICAgICAgICAgICAgLy8gcGFkZGluZ1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAyXSA9IHdpZHRoID4+IDg7ICAgLy8gd2lkdGhcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgM10gPSB3aWR0aDtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNF0gPSBoZWlnaHQgPj4gODsgIC8vIGhlaWdodFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA1XSA9IGhlaWdodDtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA2XSA9IDE7ICAgICAgICAgICAgLy8gbnVtYmVyLW9mLXNjcmVlbnNcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgN10gPSAwOyAgICAgICAgICAgIC8vIHBhZGRpbmdcblxuICAgICAgICAgICAgLy8gc2NyZWVuIGFycmF5XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDhdID0gaWQgPj4gMjQ7ICAgICAvLyBpZFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA5XSA9IGlkID4+IDE2O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxMF0gPSBpZCA+PiA4O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxMV0gPSBpZDtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTJdID0gMDsgICAgICAgICAgIC8vIHgtcG9zaXRpb25cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTNdID0gMDtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTRdID0gMDsgICAgICAgICAgIC8vIHktcG9zaXRpb25cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTVdID0gMDtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTZdID0gd2lkdGggPj4gODsgIC8vIHdpZHRoXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDE3XSA9IHdpZHRoO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxOF0gPSBoZWlnaHQgPj4gODsgLy8gaGVpZ2h0XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDE5XSA9IGhlaWdodDtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMjBdID0gZmxhZ3MgPj4gMjQ7IC8vIGZsYWdzXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDIxXSA9IGZsYWdzID4+IDE2O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAyMl0gPSBmbGFncyA+PiA4O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAyM10gPSBmbGFncztcblxuICAgICAgICAgICAgc29jay5fc1FsZW4gKz0gMjQ7XG4gICAgICAgICAgICBzb2NrLmZsdXNoKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgY2xpZW50RmVuY2U6IGZ1bmN0aW9uIChzb2NrLCBmbGFncywgcGF5bG9hZCkge1xuICAgICAgICAgICAgdmFyIGJ1ZmYgPSBzb2NrLl9zUTtcbiAgICAgICAgICAgIHZhciBvZmZzZXQgPSBzb2NrLl9zUWxlbjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXRdID0gMjQ4OyAvLyBtc2ctdHlwZVxuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDFdID0gMDsgLy8gcGFkZGluZ1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAyXSA9IDA7IC8vIHBhZGRpbmdcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgM10gPSAwOyAvLyBwYWRkaW5nXG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNF0gPSBmbGFncyA+PiAyNDsgLy8gZmxhZ3NcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNV0gPSBmbGFncyA+PiAxNjtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNl0gPSBmbGFncyA+PiA4O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA3XSA9IGZsYWdzO1xuXG4gICAgICAgICAgICB2YXIgbiA9IHBheWxvYWQubGVuZ3RoO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDhdID0gbjsgLy8gbGVuZ3RoXG5cbiAgICAgICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbjsgaSsrKSB7XG4gICAgICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA5ICsgaV0gPSBwYXlsb2FkLmNoYXJDb2RlQXQoaSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHNvY2suX3NRbGVuICs9IDkgKyBuO1xuICAgICAgICAgICAgc29jay5mbHVzaCgpO1xuICAgICAgICB9LFxuXG4gICAgICAgIGVuYWJsZUNvbnRpbnVvdXNVcGRhdGVzOiBmdW5jdGlvbiAoc29jaywgZW5hYmxlLCB4LCB5LCB3aWR0aCwgaGVpZ2h0KSB7XG4gICAgICAgICAgICB2YXIgYnVmZiA9IHNvY2suX3NRO1xuICAgICAgICAgICAgdmFyIG9mZnNldCA9IHNvY2suX3NRbGVuO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldF0gPSAxNTA7ICAgICAgICAgICAgIC8vIG1zZy10eXBlXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDFdID0gZW5hYmxlOyAgICAgIC8vIGVuYWJsZS1mbGFnXG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMl0gPSB4ID4+IDg7ICAgICAgLy8geFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAzXSA9IHg7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDRdID0geSA+PiA4OyAgICAgIC8vIHlcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNV0gPSB5O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA2XSA9IHdpZHRoID4+IDg7ICAvLyB3aWR0aFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA3XSA9IHdpZHRoO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA4XSA9IGhlaWdodCA+PiA4OyAvLyBoZWlnaHRcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgOV0gPSBoZWlnaHQ7XG5cbiAgICAgICAgICAgIHNvY2suX3NRbGVuICs9IDEwO1xuICAgICAgICAgICAgc29jay5mbHVzaCgpO1xuICAgICAgICB9LFxuXG4gICAgICAgIHBpeGVsRm9ybWF0OiBmdW5jdGlvbiAoc29jaywgYnBwLCBkZXB0aCwgdHJ1ZV9jb2xvcikge1xuICAgICAgICAgICAgdmFyIGJ1ZmYgPSBzb2NrLl9zUTtcbiAgICAgICAgICAgIHZhciBvZmZzZXQgPSBzb2NrLl9zUWxlbjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXRdID0gMDsgIC8vIG1zZy10eXBlXG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMV0gPSAwOyAvLyBwYWRkaW5nXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDJdID0gMDsgLy8gcGFkZGluZ1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAzXSA9IDA7IC8vIHBhZGRpbmdcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA0XSA9IGJwcCAqIDg7ICAgICAgICAgICAgIC8vIGJpdHMtcGVyLXBpeGVsXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDVdID0gZGVwdGggKiA4OyAgICAgICAgICAgLy8gZGVwdGhcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNl0gPSAwOyAgICAgICAgICAgICAgICAgICAvLyBsaXR0bGUtZW5kaWFuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDddID0gdHJ1ZV9jb2xvciA/IDEgOiAwOyAgLy8gdHJ1ZS1jb2xvclxuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDhdID0gMDsgICAgLy8gcmVkLW1heFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA5XSA9IDI1NTsgIC8vIHJlZC1tYXhcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxMF0gPSAwOyAgIC8vIGdyZWVuLW1heFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxMV0gPSAyNTU7IC8vIGdyZWVuLW1heFxuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDEyXSA9IDA7ICAgLy8gYmx1ZS1tYXhcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTNdID0gMjU1OyAvLyBibHVlLW1heFxuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDE0XSA9IDE2OyAgLy8gcmVkLXNoaWZ0XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDE1XSA9IDg7ICAgLy8gZ3JlZW4tc2hpZnRcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTZdID0gMDsgICAvLyBibHVlLXNoaWZ0XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTddID0gMDsgICAvLyBwYWRkaW5nXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDE4XSA9IDA7ICAgLy8gcGFkZGluZ1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxOV0gPSAwOyAgIC8vIHBhZGRpbmdcblxuICAgICAgICAgICAgc29jay5fc1FsZW4gKz0gMjA7XG4gICAgICAgICAgICBzb2NrLmZsdXNoKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgY2xpZW50RW5jb2RpbmdzOiBmdW5jdGlvbiAoc29jaywgZW5jb2RpbmdzLCBsb2NhbF9jdXJzb3IsIHRydWVfY29sb3IpIHtcbiAgICAgICAgICAgIHZhciBidWZmID0gc29jay5fc1E7XG4gICAgICAgICAgICB2YXIgb2Zmc2V0ID0gc29jay5fc1FsZW47XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0XSA9IDI7IC8vIG1zZy10eXBlXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDFdID0gMDsgLy8gcGFkZGluZ1xuXG4gICAgICAgICAgICAvLyBvZmZzZXQgKyAyIGFuZCBvZmZzZXQgKyAzIGFyZSBlbmNvZGluZyBjb3VudFxuXG4gICAgICAgICAgICB2YXIgaSwgaiA9IG9mZnNldCArIDQsIGNudCA9IDA7XG4gICAgICAgICAgICBmb3IgKGkgPSAwOyBpIDwgZW5jb2RpbmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVuY29kaW5nc1tpXVswXSA9PT0gXCJDdXJzb3JcIiAmJiAhbG9jYWxfY3Vyc29yKSB7XG4gICAgICAgICAgICAgICAgICAgIFV0aWwuRGVidWcoXCJTa2lwcGluZyBDdXJzb3IgcHNldWRvLWVuY29kaW5nXCIpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZW5jb2RpbmdzW2ldWzBdID09PSBcIlRJR0hUXCIgJiYgIXRydWVfY29sb3IpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gVE9ETzogcmVtb3ZlIHRoaXMgd2hlbiB3ZSBoYXZlIHRpZ2h0K25vbi10cnVlLWNvbG9yXG4gICAgICAgICAgICAgICAgICAgIFV0aWwuV2FybihcIlNraXBwaW5nIHRpZ2h0IGFzIGl0IGlzIG9ubHkgc3VwcG9ydGVkIHdpdGggdHJ1ZSBjb2xvclwiKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB2YXIgZW5jID0gZW5jb2RpbmdzW2ldWzFdO1xuICAgICAgICAgICAgICAgICAgICBidWZmW2pdID0gZW5jID4+IDI0O1xuICAgICAgICAgICAgICAgICAgICBidWZmW2ogKyAxXSA9IGVuYyA+PiAxNjtcbiAgICAgICAgICAgICAgICAgICAgYnVmZltqICsgMl0gPSBlbmMgPj4gODtcbiAgICAgICAgICAgICAgICAgICAgYnVmZltqICsgM10gPSBlbmM7XG5cbiAgICAgICAgICAgICAgICAgICAgaiArPSA0O1xuICAgICAgICAgICAgICAgICAgICBjbnQrKztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMl0gPSBjbnQgPj4gODtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgM10gPSBjbnQ7XG5cbiAgICAgICAgICAgIHNvY2suX3NRbGVuICs9IGogLSBvZmZzZXQ7XG4gICAgICAgICAgICBzb2NrLmZsdXNoKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgZmJVcGRhdGVSZXF1ZXN0czogZnVuY3Rpb24gKHNvY2ssIG9ubHlOb25JbmMsIGNsZWFuRGlydHksIGZiX3dpZHRoLCBmYl9oZWlnaHQpIHtcbiAgICAgICAgICAgIHZhciBvZmZzZXRJbmNyZW1lbnQgPSAwO1xuXG4gICAgICAgICAgICB2YXIgY2IgPSBjbGVhbkRpcnR5LmNsZWFuQm94O1xuICAgICAgICAgICAgdmFyIHcsIGg7XG4gICAgICAgICAgICBpZiAoIW9ubHlOb25JbmMgJiYgKGNiLncgPiAwICYmIGNiLmggPiAwKSkge1xuICAgICAgICAgICAgICAgIHcgPSB0eXBlb2YgY2IudyA9PT0gXCJ1bmRlZmluZWRcIiA/IGZiX3dpZHRoIDogY2IudztcbiAgICAgICAgICAgICAgICBoID0gdHlwZW9mIGNiLmggPT09IFwidW5kZWZpbmVkXCIgPyBmYl9oZWlnaHQgOiBjYi5oO1xuICAgICAgICAgICAgICAgIC8vIFJlcXVlc3QgaW5jcmVtZW50YWwgZm9yIGNsZWFuIGJveFxuICAgICAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5mYlVwZGF0ZVJlcXVlc3Qoc29jaywgMSwgY2IueCwgY2IueSwgdywgaCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgY2xlYW5EaXJ0eS5kaXJ0eUJveGVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgdmFyIGRiID0gY2xlYW5EaXJ0eS5kaXJ0eUJveGVzW2ldO1xuICAgICAgICAgICAgICAgIC8vIEZvcmNlIGFsbCAobm9uLWluY3JlbWVudGFsKSBmb3IgZGlydHkgYm94XG4gICAgICAgICAgICAgICAgdyA9IHR5cGVvZiBkYi53ID09PSBcInVuZGVmaW5lZFwiID8gZmJfd2lkdGggOiBkYi53O1xuICAgICAgICAgICAgICAgIGggPSB0eXBlb2YgZGIuaCA9PT0gXCJ1bmRlZmluZWRcIiA/IGZiX2hlaWdodCA6IGRiLmg7XG4gICAgICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmZiVXBkYXRlUmVxdWVzdChzb2NrLCAwLCBkYi54LCBkYi55LCB3LCBoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBmYlVwZGF0ZVJlcXVlc3Q6IGZ1bmN0aW9uIChzb2NrLCBpbmNyZW1lbnRhbCwgeCwgeSwgdywgaCkge1xuICAgICAgICAgICAgdmFyIGJ1ZmYgPSBzb2NrLl9zUTtcbiAgICAgICAgICAgIHZhciBvZmZzZXQgPSBzb2NrLl9zUWxlbjtcblxuICAgICAgICAgICAgaWYgKHR5cGVvZih4KSA9PT0gXCJ1bmRlZmluZWRcIikgeyB4ID0gMDsgfVxuICAgICAgICAgICAgaWYgKHR5cGVvZih5KSA9PT0gXCJ1bmRlZmluZWRcIikgeyB5ID0gMDsgfVxuXG4gICAgICAgICAgICBidWZmW29mZnNldF0gPSAzOyAgLy8gbXNnLXR5cGVcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMV0gPSBpbmNyZW1lbnRhbDtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAyXSA9ICh4ID4+IDgpICYgMHhGRjtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgM10gPSB4ICYgMHhGRjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA0XSA9ICh5ID4+IDgpICYgMHhGRjtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNV0gPSB5ICYgMHhGRjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA2XSA9ICh3ID4+IDgpICYgMHhGRjtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgN10gPSB3ICYgMHhGRjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA4XSA9IChoID4+IDgpICYgMHhGRjtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgOV0gPSBoICYgMHhGRjtcblxuICAgICAgICAgICAgc29jay5fc1FsZW4gKz0gMTA7XG4gICAgICAgICAgICBzb2NrLmZsdXNoKCk7XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgUkZCLmdlbkRFUyA9IGZ1bmN0aW9uIChwYXNzd29yZCwgY2hhbGxlbmdlKSB7XG4gICAgICAgIHZhciBwYXNzd2QgPSBbXTtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBwYXNzd29yZC5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgcGFzc3dkLnB1c2gocGFzc3dvcmQuY2hhckNvZGVBdChpKSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIChuZXcgREVTKHBhc3N3ZCkpLmVuY3J5cHQoY2hhbGxlbmdlKTtcbiAgICB9O1xuXG4gICAgUkZCLmV4dHJhY3RfZGF0YV91cmkgPSBmdW5jdGlvbiAoYXJyKSB7XG4gICAgICAgIHJldHVybiBcIjtiYXNlNjQsXCIgKyBCYXNlNjQuZW5jb2RlKGFycik7XG4gICAgfTtcblxuICAgIFJGQi5lbmNvZGluZ0hhbmRsZXJzID0ge1xuICAgICAgICBSQVc6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9GQlUubGluZXMgPT09IDApIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUubGluZXMgPSB0aGlzLl9GQlUuaGVpZ2h0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgPSB0aGlzLl9GQlUud2lkdGggKiB0aGlzLl9mYl9CcHA7ICAvLyBhdCBsZWFzdCBhIGxpbmVcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlJBV1wiLCB0aGlzLl9GQlUuYnl0ZXMpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgdmFyIGN1cl95ID0gdGhpcy5fRkJVLnkgKyAodGhpcy5fRkJVLmhlaWdodCAtIHRoaXMuX0ZCVS5saW5lcyk7XG4gICAgICAgICAgICB2YXIgY3Vycl9oZWlnaHQgPSBNYXRoLm1pbih0aGlzLl9GQlUubGluZXMsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBNYXRoLmZsb29yKHRoaXMuX3NvY2suclFsZW4oKSAvICh0aGlzLl9GQlUud2lkdGggKiB0aGlzLl9mYl9CcHApKSk7XG4gICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmJsaXRJbWFnZSh0aGlzLl9GQlUueCwgY3VyX3ksIHRoaXMuX0ZCVS53aWR0aCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGN1cnJfaGVpZ2h0LCB0aGlzLl9zb2NrLmdldF9yUSgpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5nZXRfclFpKCkpO1xuICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcyh0aGlzLl9GQlUud2lkdGggKiBjdXJyX2hlaWdodCAqIHRoaXMuX2ZiX0JwcCk7XG4gICAgICAgICAgICB0aGlzLl9GQlUubGluZXMgLT0gY3Vycl9oZWlnaHQ7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9GQlUubGluZXMgPiAwKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gdGhpcy5fRkJVLndpZHRoICogdGhpcy5fZmJfQnBwOyAgLy8gQXQgbGVhc3QgYW5vdGhlciBsaW5lXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5yZWN0cy0tO1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDA7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIENPUFlSRUNUOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgPSA0O1xuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiQ09QWVJFQ1RcIiwgNCkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmNvcHlJbWFnZSh0aGlzLl9zb2NrLnJRc2hpZnQxNigpLCB0aGlzLl9zb2NrLnJRc2hpZnQxNigpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLngsIHRoaXMuX0ZCVS55LCB0aGlzLl9GQlUud2lkdGgsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuaGVpZ2h0KTtcblxuICAgICAgICAgICAgdGhpcy5fRkJVLnJlY3RzLS07XG4gICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgPSAwO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgUlJFOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB2YXIgY29sb3I7XG4gICAgICAgICAgICBpZiAodGhpcy5fRkJVLnN1YnJlY3RzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gNCArIHRoaXMuX2ZiX0JwcDtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJSUkVcIiwgNCArIHRoaXMuX2ZiX0JwcCkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLnN1YnJlY3RzID0gdGhpcy5fc29jay5yUXNoaWZ0MzIoKTtcbiAgICAgICAgICAgICAgICBjb2xvciA9IHRoaXMuX3NvY2suclFzaGlmdEJ5dGVzKHRoaXMuX2ZiX0JwcCk7ICAvLyBCYWNrZ3JvdW5kXG4gICAgICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5maWxsUmVjdCh0aGlzLl9GQlUueCwgdGhpcy5fRkJVLnksIHRoaXMuX0ZCVS53aWR0aCwgdGhpcy5fRkJVLmhlaWdodCwgY29sb3IpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB3aGlsZSAodGhpcy5fRkJVLnN1YnJlY3RzID4gMCAmJiB0aGlzLl9zb2NrLnJRbGVuKCkgPj0gKHRoaXMuX2ZiX0JwcCArIDgpKSB7XG4gICAgICAgICAgICAgICAgY29sb3IgPSB0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyh0aGlzLl9mYl9CcHApO1xuICAgICAgICAgICAgICAgIHZhciB4ID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgICAgICB2YXIgeSA9IHRoaXMuX3NvY2suclFzaGlmdDE2KCk7XG4gICAgICAgICAgICAgICAgdmFyIHdpZHRoID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgICAgICB2YXIgaGVpZ2h0ID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmZpbGxSZWN0KHRoaXMuX0ZCVS54ICsgeCwgdGhpcy5fRkJVLnkgKyB5LCB3aWR0aCwgaGVpZ2h0LCBjb2xvcik7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLnN1YnJlY3RzLS07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9GQlUuc3VicmVjdHMgPiAwKSB7XG4gICAgICAgICAgICAgICAgdmFyIGNodW5rID0gTWF0aC5taW4odGhpcy5fcnJlX2NodW5rX3N6LCB0aGlzLl9GQlUuc3VicmVjdHMpO1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9ICh0aGlzLl9mYl9CcHAgKyA4KSAqIGNodW5rO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUucmVjdHMtLTtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgPSAwO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBIRVhUSUxFOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB2YXIgclEgPSB0aGlzLl9zb2NrLmdldF9yUSgpO1xuICAgICAgICAgICAgdmFyIHJRaSA9IHRoaXMuX3NvY2suZ2V0X3JRaSgpO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5fRkJVLnRpbGVzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLnRpbGVzX3ggPSBNYXRoLmNlaWwodGhpcy5fRkJVLndpZHRoIC8gMTYpO1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS50aWxlc195ID0gTWF0aC5jZWlsKHRoaXMuX0ZCVS5oZWlnaHQgLyAxNik7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLnRvdGFsX3RpbGVzID0gdGhpcy5fRkJVLnRpbGVzX3ggKiB0aGlzLl9GQlUudGlsZXNfeTtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUudGlsZXMgPSB0aGlzLl9GQlUudG90YWxfdGlsZXM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHdoaWxlICh0aGlzLl9GQlUudGlsZXMgPiAwKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gMTtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJIRVhUSUxFIHN1YmVuY29kaW5nXCIsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICAgICAgdmFyIHN1YmVuY29kaW5nID0gclFbclFpXTsgIC8vIFBlZWtcbiAgICAgICAgICAgICAgICBpZiAoc3ViZW5jb2RpbmcgPiAzMCkgeyAgLy8gUmF3XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZhaWwoXCJEaXNjb25uZWN0ZWQ6IGlsbGVnYWwgaGV4dGlsZSBzdWJlbmNvZGluZyBcIiArIHN1YmVuY29kaW5nKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHZhciBzdWJyZWN0cyA9IDA7XG4gICAgICAgICAgICAgICAgdmFyIGN1cnJfdGlsZSA9IHRoaXMuX0ZCVS50b3RhbF90aWxlcyAtIHRoaXMuX0ZCVS50aWxlcztcbiAgICAgICAgICAgICAgICB2YXIgdGlsZV94ID0gY3Vycl90aWxlICUgdGhpcy5fRkJVLnRpbGVzX3g7XG4gICAgICAgICAgICAgICAgdmFyIHRpbGVfeSA9IE1hdGguZmxvb3IoY3Vycl90aWxlIC8gdGhpcy5fRkJVLnRpbGVzX3gpO1xuICAgICAgICAgICAgICAgIHZhciB4ID0gdGhpcy5fRkJVLnggKyB0aWxlX3ggKiAxNjtcbiAgICAgICAgICAgICAgICB2YXIgeSA9IHRoaXMuX0ZCVS55ICsgdGlsZV95ICogMTY7XG4gICAgICAgICAgICAgICAgdmFyIHcgPSBNYXRoLm1pbigxNiwgKHRoaXMuX0ZCVS54ICsgdGhpcy5fRkJVLndpZHRoKSAtIHgpO1xuICAgICAgICAgICAgICAgIHZhciBoID0gTWF0aC5taW4oMTYsICh0aGlzLl9GQlUueSArIHRoaXMuX0ZCVS5oZWlnaHQpIC0geSk7XG5cbiAgICAgICAgICAgICAgICAvLyBGaWd1cmUgb3V0IGhvdyBtdWNoIHdlIGFyZSBleHBlY3RpbmdcbiAgICAgICAgICAgICAgICBpZiAoc3ViZW5jb2RpbmcgJiAweDAxKSB7ICAvLyBSYXdcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzICs9IHcgKiBoICogdGhpcy5fZmJfQnBwO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJlbmNvZGluZyAmIDB4MDIpIHsgIC8vIEJhY2tncm91bmRcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyArPSB0aGlzLl9mYl9CcHA7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YmVuY29kaW5nICYgMHgwNCkgeyAgLy8gRm9yZWdyb3VuZFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzICs9IHRoaXMuX2ZiX0JwcDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViZW5jb2RpbmcgJiAweDA4KSB7ICAvLyBBbnlTdWJyZWN0c1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzKys7ICAvLyBTaW5jZSB3ZSBhcmVuJ3Qgc2hpZnRpbmcgaXQgb2ZmXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJoZXh0aWxlIHN1YnJlY3RzIGhlYWRlclwiLCB0aGlzLl9GQlUuYnl0ZXMpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgc3VicmVjdHMgPSByUVtyUWkgKyB0aGlzLl9GQlUuYnl0ZXMgLSAxXTsgIC8vIFBlZWtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChzdWJlbmNvZGluZyAmIDB4MTApIHsgIC8vIFN1YnJlY3RzQ29sb3VyZWRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgKz0gc3VicmVjdHMgKiAodGhpcy5fZmJfQnBwICsgMik7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyArPSBzdWJyZWN0cyAqIDI7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJoZXh0aWxlXCIsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgICAgICAvLyBXZSBrbm93IHRoZSBlbmNvZGluZyBhbmQgaGF2ZSBhIHdob2xlIHRpbGVcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUuc3ViZW5jb2RpbmcgPSByUVtyUWldO1xuICAgICAgICAgICAgICAgIHJRaSsrO1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9GQlUuc3ViZW5jb2RpbmcgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX0ZCVS5sYXN0c3ViZW5jb2RpbmcgJiAweDAxKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBXZWlyZDogaWdub3JlIGJsYW5rcyBhcmUgUkFXXG4gICAgICAgICAgICAgICAgICAgICAgICBVdGlsLkRlYnVnKFwiICAgICBJZ25vcmluZyBibGFuayBhZnRlciBSQVdcIik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmZpbGxSZWN0KHgsIHksIHcsIGgsIHRoaXMuX0ZCVS5iYWNrZ3JvdW5kKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy5fRkJVLnN1YmVuY29kaW5nICYgMHgwMSkgeyAgLy8gUmF3XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuYmxpdEltYWdlKHgsIHksIHcsIGgsIHJRLCByUWkpO1xuICAgICAgICAgICAgICAgICAgICByUWkgKz0gdGhpcy5fRkJVLmJ5dGVzIC0gMTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fRkJVLnN1YmVuY29kaW5nICYgMHgwMikgeyAgLy8gQmFja2dyb3VuZFxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX2ZiX0JwcCA9PSAxKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJhY2tncm91bmQgPSByUVtyUWldO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBmYl9CcHAgaXMgNFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5iYWNrZ3JvdW5kID0gW3JRW3JRaV0sIHJRW3JRaSArIDFdLCByUVtyUWkgKyAyXSwgclFbclFpICsgM11dO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgclFpICs9IHRoaXMuX2ZiX0JwcDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fRkJVLnN1YmVuY29kaW5nICYgMHgwNCkgeyAgLy8gRm9yZWdyb3VuZFxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX2ZiX0JwcCA9PSAxKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmZvcmVncm91bmQgPSByUVtyUWldO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyB0aGlzLl9mYl9CcHAgaXMgNFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5mb3JlZ3JvdW5kID0gW3JRW3JRaV0sIHJRW3JRaSArIDFdLCByUVtyUWkgKyAyXSwgclFbclFpICsgM11dO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgclFpICs9IHRoaXMuX2ZiX0JwcDtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuc3RhcnRUaWxlKHgsIHksIHcsIGgsIHRoaXMuX0ZCVS5iYWNrZ3JvdW5kKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX0ZCVS5zdWJlbmNvZGluZyAmIDB4MDgpIHsgIC8vIEFueVN1YnJlY3RzXG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJyZWN0cyA9IHJRW3JRaV07XG4gICAgICAgICAgICAgICAgICAgICAgICByUWkrKztcblxuICAgICAgICAgICAgICAgICAgICAgICAgZm9yICh2YXIgcyA9IDA7IHMgPCBzdWJyZWN0czsgcysrKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFyIGNvbG9yO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9GQlUuc3ViZW5jb2RpbmcgJiAweDEwKSB7ICAvLyBTdWJyZWN0c0NvbG91cmVkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9mYl9CcHAgPT09IDEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbG9yID0gclFbclFpXTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIF9mYl9CcHAgaXMgNFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3IgPSBbclFbclFpXSwgclFbclFpICsgMV0sIHJRW3JRaSArIDJdLCByUVtyUWkgKyAzXV07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgclFpICs9IHRoaXMuX2ZiX0JwcDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb2xvciA9IHRoaXMuX0ZCVS5mb3JlZ3JvdW5kO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YXIgeHkgPSByUVtyUWldO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJRaSsrO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhciBzeCA9ICh4eSA+PiA0KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YXIgc3kgPSAoeHkgJiAweDBmKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhciB3aCA9IHJRW3JRaV07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgclFpKys7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFyIHN3ID0gKHdoID4+IDQpICsgMTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YXIgc2ggPSAod2ggJiAweDBmKSArIDE7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LnN1YlRpbGUoc3gsIHN5LCBzdywgc2gsIGNvbG9yKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmZpbmlzaFRpbGUoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5zZXRfclFpKHJRaSk7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLmxhc3RzdWJlbmNvZGluZyA9IHRoaXMuX0ZCVS5zdWJlbmNvZGluZztcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgPSAwO1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS50aWxlcy0tO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5fRkJVLnRpbGVzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLnJlY3RzLS07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIGdldFRpZ2h0Q0xlbmd0aDogZnVuY3Rpb24gKGFycikge1xuICAgICAgICAgICAgdmFyIGhlYWRlciA9IDEsIGRhdGEgPSAwO1xuICAgICAgICAgICAgZGF0YSArPSBhcnJbMF0gJiAweDdmO1xuICAgICAgICAgICAgaWYgKGFyclswXSAmIDB4ODApIHtcbiAgICAgICAgICAgICAgICBoZWFkZXIrKztcbiAgICAgICAgICAgICAgICBkYXRhICs9IChhcnJbMV0gJiAweDdmKSA8PCA3O1xuICAgICAgICAgICAgICAgIGlmIChhcnJbMV0gJiAweDgwKSB7XG4gICAgICAgICAgICAgICAgICAgIGhlYWRlcisrO1xuICAgICAgICAgICAgICAgICAgICBkYXRhICs9IGFyclsyXSA8PCAxNDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gW2hlYWRlciwgZGF0YV07XG4gICAgICAgIH0sXG5cbiAgICAgICAgZGlzcGxheV90aWdodDogZnVuY3Rpb24gKGlzVGlnaHRQTkcpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9mYl9kZXB0aCA9PT0gMSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX2ZhaWwoXCJUaWdodCBwcm90b2NvbCBoYW5kbGVyIG9ubHkgaW1wbGVtZW50cyB0cnVlIGNvbG9yIG1vZGVcIik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDE7ICAvLyBjb21wcmVzc2lvbi1jb250cm9sIGJ5dGVcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlRJR0hUIGNvbXByZXNzaW9uLWNvbnRyb2xcIiwgdGhpcy5fRkJVLmJ5dGVzKSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgdmFyIGNoZWNrc3VtID0gZnVuY3Rpb24gKGRhdGEpIHtcbiAgICAgICAgICAgICAgICB2YXIgc3VtID0gMDtcbiAgICAgICAgICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGRhdGEubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgICAgICAgc3VtICs9IGRhdGFbaV07XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdW0gPiA2NTUzNikgc3VtIC09IDY1NTM2O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gc3VtO1xuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgdmFyIHJlc2V0U3RyZWFtcyA9IDA7XG4gICAgICAgICAgICB2YXIgc3RyZWFtSWQgPSAtMTtcbiAgICAgICAgICAgIHZhciBkZWNvbXByZXNzID0gZnVuY3Rpb24gKGRhdGEsIGV4cGVjdGVkKSB7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCA0OyBpKyspIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKChyZXNldFN0cmVhbXMgPj4gaSkgJiAxKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuemxpYnNbaV0ucmVzZXQoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIFV0aWwuSW5mbyhcIlJlc2V0IHpsaWIgc3RyZWFtIFwiICsgaSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL3ZhciB1bmNvbXByZXNzZWQgPSB0aGlzLl9GQlUuemxpYnNbc3RyZWFtSWRdLnVuY29tcHJlc3MoZGF0YSwgMCk7XG4gICAgICAgICAgICAgICAgdmFyIHVuY29tcHJlc3NlZCA9IHRoaXMuX0ZCVS56bGlic1tzdHJlYW1JZF0uaW5mbGF0ZShkYXRhLCB0cnVlLCBleHBlY3RlZCk7XG4gICAgICAgICAgICAgICAgLyppZiAodW5jb21wcmVzc2VkLnN0YXR1cyAhPT0gMCkge1xuICAgICAgICAgICAgICAgICAgICBVdGlsLkVycm9yKFwiSW52YWxpZCBkYXRhIGluIHpsaWIgc3RyZWFtXCIpO1xuICAgICAgICAgICAgICAgIH0qL1xuXG4gICAgICAgICAgICAgICAgLy9yZXR1cm4gdW5jb21wcmVzc2VkLmRhdGE7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHVuY29tcHJlc3NlZDtcbiAgICAgICAgICAgIH0uYmluZCh0aGlzKTtcblxuICAgICAgICAgICAgdmFyIGluZGV4ZWRUb1JHQlgyQ29sb3IgPSBmdW5jdGlvbiAoZGF0YSwgcGFsZXR0ZSwgd2lkdGgsIGhlaWdodCkge1xuICAgICAgICAgICAgICAgIC8vIENvbnZlcnQgaW5kZXhlZCAocGFsZXR0ZSBiYXNlZCkgaW1hZ2UgZGF0YSB0byBSR0JcbiAgICAgICAgICAgICAgICAvLyBUT0RPOiByZWR1Y2UgbnVtYmVyIG9mIGNhbGN1bGF0aW9ucyBpbnNpZGUgbG9vcFxuICAgICAgICAgICAgICAgIHZhciBkZXN0ID0gdGhpcy5fZGVzdEJ1ZmY7XG4gICAgICAgICAgICAgICAgdmFyIHcgPSBNYXRoLmZsb29yKCh3aWR0aCArIDcpIC8gOCk7XG4gICAgICAgICAgICAgICAgdmFyIHcxID0gTWF0aC5mbG9vcih3aWR0aCAvIDgpO1xuXG4gICAgICAgICAgICAgICAgLypmb3IgKHZhciB5ID0gMDsgeSA8IGhlaWdodDsgeSsrKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBiLCB4LCBkcCwgc3A7XG4gICAgICAgICAgICAgICAgICAgIHZhciB5b2Zmc2V0ID0geSAqIHdpZHRoO1xuICAgICAgICAgICAgICAgICAgICB2YXIgeWJpdG9mZnNldCA9IHkgKiB3O1xuICAgICAgICAgICAgICAgICAgICB2YXIgeG9mZnNldCwgdGFyZ2V0Ynl0ZTtcbiAgICAgICAgICAgICAgICAgICAgZm9yICh4ID0gMDsgeCA8IHcxOyB4KyspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHhvZmZzZXQgPSB5b2Zmc2V0ICsgeCAqIDg7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXRieXRlID0gZGF0YVt5Yml0b2Zmc2V0ICsgeF07XG4gICAgICAgICAgICAgICAgICAgICAgICBmb3IgKGIgPSA3OyBiID49IDA7IGItLSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRwID0gKHhvZmZzZXQgKyA3IC0gYikgKiAzO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNwID0gKHRhcmdldGJ5dGUgPj4gYiAmIDEpICogMztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0W2RwXSA9IHBhbGV0dGVbc3BdO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RbZHAgKyAxXSA9IHBhbGV0dGVbc3AgKyAxXTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0W2RwICsgMl0gPSBwYWxldHRlW3NwICsgMl07XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB4b2Zmc2V0ID0geW9mZnNldCArIHggKiA4O1xuICAgICAgICAgICAgICAgICAgICB0YXJnZXRieXRlID0gZGF0YVt5Yml0b2Zmc2V0ICsgeF07XG4gICAgICAgICAgICAgICAgICAgIGZvciAoYiA9IDc7IGIgPj0gOCAtIHdpZHRoICUgODsgYi0tKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkcCA9ICh4b2Zmc2V0ICsgNyAtIGIpICogMztcbiAgICAgICAgICAgICAgICAgICAgICAgIHNwID0gKHRhcmdldGJ5dGUgPj4gYiAmIDEpICogMztcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RbZHBdID0gcGFsZXR0ZVtzcF07XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0W2RwICsgMV0gPSBwYWxldHRlW3NwICsgMV07XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0W2RwICsgMl0gPSBwYWxldHRlW3NwICsgMl07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9Ki9cblxuICAgICAgICAgICAgICAgIGZvciAodmFyIHkgPSAwOyB5IDwgaGVpZ2h0OyB5KyspIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGIsIHgsIGRwLCBzcDtcbiAgICAgICAgICAgICAgICAgICAgZm9yICh4ID0gMDsgeCA8IHcxOyB4KyspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvciAoYiA9IDc7IGIgPj0gMDsgYi0tKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZHAgPSAoeSAqIHdpZHRoICsgeCAqIDggKyA3IC0gYikgKiA0O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNwID0gKGRhdGFbeSAqIHcgKyB4XSA+PiBiICYgMSkgKiAzO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RbZHBdID0gcGFsZXR0ZVtzcF07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVzdFtkcCArIDFdID0gcGFsZXR0ZVtzcCArIDFdO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RbZHAgKyAyXSA9IHBhbGV0dGVbc3AgKyAyXTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0W2RwICsgM10gPSAyNTU7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBmb3IgKGIgPSA3OyBiID49IDggLSB3aWR0aCAlIDg7IGItLSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZHAgPSAoeSAqIHdpZHRoICsgeCAqIDggKyA3IC0gYikgKiA0O1xuICAgICAgICAgICAgICAgICAgICAgICAgc3AgPSAoZGF0YVt5ICogdyArIHhdID4+IGIgJiAxKSAqIDM7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0W2RwXSA9IHBhbGV0dGVbc3BdO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdFtkcCArIDFdID0gcGFsZXR0ZVtzcCArIDFdO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdFtkcCArIDJdID0gcGFsZXR0ZVtzcCArIDJdO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdFtkcCArIDNdID0gMjU1O1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGRlc3Q7XG4gICAgICAgICAgICB9LmJpbmQodGhpcyk7XG5cbiAgICAgICAgICAgIHZhciBpbmRleGVkVG9SR0JYID0gZnVuY3Rpb24gKGRhdGEsIHBhbGV0dGUsIHdpZHRoLCBoZWlnaHQpIHtcbiAgICAgICAgICAgICAgICAvLyBDb252ZXJ0IGluZGV4ZWQgKHBhbGV0dGUgYmFzZWQpIGltYWdlIGRhdGEgdG8gUkdCXG4gICAgICAgICAgICAgICAgdmFyIGRlc3QgPSB0aGlzLl9kZXN0QnVmZjtcbiAgICAgICAgICAgICAgICB2YXIgdG90YWwgPSB3aWR0aCAqIGhlaWdodCAqIDQ7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgaSA9IDAsIGogPSAwOyBpIDwgdG90YWw7IGkgKz0gNCwgaisrKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBzcCA9IGRhdGFbal0gKiAzO1xuICAgICAgICAgICAgICAgICAgICBkZXN0W2ldID0gcGFsZXR0ZVtzcF07XG4gICAgICAgICAgICAgICAgICAgIGRlc3RbaSArIDFdID0gcGFsZXR0ZVtzcCArIDFdO1xuICAgICAgICAgICAgICAgICAgICBkZXN0W2kgKyAyXSA9IHBhbGV0dGVbc3AgKyAyXTtcbiAgICAgICAgICAgICAgICAgICAgZGVzdFtpICsgM10gPSAyNTU7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGRlc3Q7XG4gICAgICAgICAgICB9LmJpbmQodGhpcyk7XG5cbiAgICAgICAgICAgIHZhciByUWkgPSB0aGlzLl9zb2NrLmdldF9yUWkoKTtcbiAgICAgICAgICAgIHZhciByUSA9IHRoaXMuX3NvY2suclF3aG9sZSgpO1xuICAgICAgICAgICAgdmFyIGNtb2RlLCBkYXRhO1xuICAgICAgICAgICAgdmFyIGNsX2hlYWRlciwgY2xfZGF0YTtcblxuICAgICAgICAgICAgdmFyIGhhbmRsZVBhbGV0dGUgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgdmFyIG51bUNvbG9ycyA9IHJRW3JRaSArIDJdICsgMTtcbiAgICAgICAgICAgICAgICB2YXIgcGFsZXR0ZVNpemUgPSBudW1Db2xvcnMgKiB0aGlzLl9mYl9kZXB0aDtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgKz0gcGFsZXR0ZVNpemU7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiVElHSFQgcGFsZXR0ZSBcIiArIGNtb2RlLCB0aGlzLl9GQlUuYnl0ZXMpKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgICAgICAgICAgICAgdmFyIGJwcCA9IChudW1Db2xvcnMgPD0gMikgPyAxIDogODtcbiAgICAgICAgICAgICAgICB2YXIgcm93U2l6ZSA9IE1hdGguZmxvb3IoKHRoaXMuX0ZCVS53aWR0aCAqIGJwcCArIDcpIC8gOCk7XG4gICAgICAgICAgICAgICAgdmFyIHJhdyA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIGlmIChyb3dTaXplICogdGhpcy5fRkJVLmhlaWdodCA8IDEyKSB7XG4gICAgICAgICAgICAgICAgICAgIHJhdyA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGNsX2hlYWRlciA9IDA7XG4gICAgICAgICAgICAgICAgICAgIGNsX2RhdGEgPSByb3dTaXplICogdGhpcy5fRkJVLmhlaWdodDtcbiAgICAgICAgICAgICAgICAgICAgLy9jbGVuZ3RoID0gWzAsIHJvd1NpemUgKiB0aGlzLl9GQlUuaGVpZ2h0XTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvLyBiZWdpbiBpbmxpbmUgZ2V0VGlnaHRDTGVuZ3RoIChyZXR1cm5pbmcgdHdvLWl0ZW0gYXJyYXlzIGlzIGJhZCBmb3IgcGVyZm9ybWFuY2Ugd2l0aCBHQylcbiAgICAgICAgICAgICAgICAgICAgdmFyIGNsX29mZnNldCA9IHJRaSArIDMgKyBwYWxldHRlU2l6ZTtcbiAgICAgICAgICAgICAgICAgICAgY2xfaGVhZGVyID0gMTtcbiAgICAgICAgICAgICAgICAgICAgY2xfZGF0YSA9IDA7XG4gICAgICAgICAgICAgICAgICAgIGNsX2RhdGEgKz0gclFbY2xfb2Zmc2V0XSAmIDB4N2Y7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyUVtjbF9vZmZzZXRdICYgMHg4MCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2xfaGVhZGVyKys7XG4gICAgICAgICAgICAgICAgICAgICAgICBjbF9kYXRhICs9IChyUVtjbF9vZmZzZXQgKyAxXSAmIDB4N2YpIDw8IDc7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoclFbY2xfb2Zmc2V0ICsgMV0gJiAweDgwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2xfaGVhZGVyKys7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2xfZGF0YSArPSByUVtjbF9vZmZzZXQgKyAyXSA8PCAxNDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAvLyBlbmQgaW5saW5lIGdldFRpZ2h0Q0xlbmd0aFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyArPSBjbF9oZWFkZXIgKyBjbF9kYXRhO1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlRJR0hUIFwiICsgY21vZGUsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgICAgICAvLyBTaGlmdCBjdGwsIGZpbHRlciBpZCwgbnVtIGNvbG9ycywgcGFsZXR0ZSBlbnRyaWVzLCBhbmQgY2xlbmd0aCBvZmZcbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKDMpO1xuICAgICAgICAgICAgICAgIC8vdmFyIHBhbGV0dGUgPSB0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyhwYWxldHRlU2l6ZSk7XG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNoaWZ0VG8odGhpcy5fcGFsZXR0ZUJ1ZmYsIHBhbGV0dGVTaXplKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKGNsX2hlYWRlcik7XG5cbiAgICAgICAgICAgICAgICBpZiAocmF3KSB7XG4gICAgICAgICAgICAgICAgICAgIGRhdGEgPSB0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyhjbF9kYXRhKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBkYXRhID0gZGVjb21wcmVzcyh0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyhjbF9kYXRhKSwgcm93U2l6ZSAqIHRoaXMuX0ZCVS5oZWlnaHQpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vIENvbnZlcnQgaW5kZXhlZCAocGFsZXR0ZSBiYXNlZCkgaW1hZ2UgZGF0YSB0byBSR0JcbiAgICAgICAgICAgICAgICB2YXIgcmdieDtcbiAgICAgICAgICAgICAgICBpZiAobnVtQ29sb3JzID09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgcmdieCA9IGluZGV4ZWRUb1JHQlgyQ29sb3IoZGF0YSwgdGhpcy5fcGFsZXR0ZUJ1ZmYsIHRoaXMuX0ZCVS53aWR0aCwgdGhpcy5fRkJVLmhlaWdodCk7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuYmxpdFJnYnhJbWFnZSh0aGlzLl9GQlUueCwgdGhpcy5fRkJVLnksIHRoaXMuX0ZCVS53aWR0aCwgdGhpcy5fRkJVLmhlaWdodCwgcmdieCwgMCwgZmFsc2UpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJnYnggPSBpbmRleGVkVG9SR0JYKGRhdGEsIHRoaXMuX3BhbGV0dGVCdWZmLCB0aGlzLl9GQlUud2lkdGgsIHRoaXMuX0ZCVS5oZWlnaHQpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmJsaXRSZ2J4SW1hZ2UodGhpcy5fRkJVLngsIHRoaXMuX0ZCVS55LCB0aGlzLl9GQlUud2lkdGgsIHRoaXMuX0ZCVS5oZWlnaHQsIHJnYngsIDAsIGZhbHNlKTtcbiAgICAgICAgICAgICAgICB9XG5cblxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfS5iaW5kKHRoaXMpO1xuXG4gICAgICAgICAgICB2YXIgaGFuZGxlQ29weSA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICB2YXIgcmF3ID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgdmFyIHVuY29tcHJlc3NlZFNpemUgPSB0aGlzLl9GQlUud2lkdGggKiB0aGlzLl9GQlUuaGVpZ2h0ICogdGhpcy5fZmJfZGVwdGg7XG4gICAgICAgICAgICAgICAgaWYgKHVuY29tcHJlc3NlZFNpemUgPCAxMikge1xuICAgICAgICAgICAgICAgICAgICByYXcgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIgPSAwO1xuICAgICAgICAgICAgICAgICAgICBjbF9kYXRhID0gdW5jb21wcmVzc2VkU2l6ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvLyBiZWdpbiBpbmxpbmUgZ2V0VGlnaHRDTGVuZ3RoIChyZXR1cm5pbmcgdHdvLWl0ZW0gYXJyYXlzIGlzIGZvciBwZWZvcm1hbmNlIHdpdGggR0MpXG4gICAgICAgICAgICAgICAgICAgIHZhciBjbF9vZmZzZXQgPSByUWkgKyAxO1xuICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIgPSAxO1xuICAgICAgICAgICAgICAgICAgICBjbF9kYXRhID0gMDtcbiAgICAgICAgICAgICAgICAgICAgY2xfZGF0YSArPSByUVtjbF9vZmZzZXRdICYgMHg3ZjtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJRW2NsX29mZnNldF0gJiAweDgwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIrKztcbiAgICAgICAgICAgICAgICAgICAgICAgIGNsX2RhdGEgKz0gKHJRW2NsX29mZnNldCArIDFdICYgMHg3ZikgPDwgNztcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChyUVtjbF9vZmZzZXQgKyAxXSAmIDB4ODApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIrKztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbF9kYXRhICs9IHJRW2NsX29mZnNldCArIDJdIDw8IDE0O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIC8vIGVuZCBpbmxpbmUgZ2V0VGlnaHRDTGVuZ3RoXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDEgKyBjbF9oZWFkZXIgKyBjbF9kYXRhO1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlRJR0hUIFwiICsgY21vZGUsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgICAgICAvLyBTaGlmdCBjdGwsIGNsZW5ndGggb2ZmXG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNoaWZ0Qnl0ZXMoMSArIGNsX2hlYWRlcik7XG5cbiAgICAgICAgICAgICAgICBpZiAocmF3KSB7XG4gICAgICAgICAgICAgICAgICAgIGRhdGEgPSB0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyhjbF9kYXRhKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBkYXRhID0gZGVjb21wcmVzcyh0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyhjbF9kYXRhKSwgdW5jb21wcmVzc2VkU2l6ZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5ibGl0UmdiSW1hZ2UodGhpcy5fRkJVLngsIHRoaXMuX0ZCVS55LCB0aGlzLl9GQlUud2lkdGgsIHRoaXMuX0ZCVS5oZWlnaHQsIGRhdGEsIDAsIGZhbHNlKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfS5iaW5kKHRoaXMpO1xuXG4gICAgICAgICAgICB2YXIgY3RsID0gdGhpcy5fc29jay5yUXBlZWs4KCk7XG5cbiAgICAgICAgICAgIC8vIEtlZXAgdGlnaHQgcmVzZXQgYml0c1xuICAgICAgICAgICAgcmVzZXRTdHJlYW1zID0gY3RsICYgMHhGO1xuXG4gICAgICAgICAgICAvLyBGaWd1cmUgb3V0IGZpbHRlclxuICAgICAgICAgICAgY3RsID0gY3RsID4+IDQ7XG4gICAgICAgICAgICBzdHJlYW1JZCA9IGN0bCAmIDB4MztcblxuICAgICAgICAgICAgaWYgKGN0bCA9PT0gMHgwOCkgICAgICAgY21vZGUgPSBcImZpbGxcIjtcbiAgICAgICAgICAgIGVsc2UgaWYgKGN0bCA9PT0gMHgwOSkgIGNtb2RlID0gXCJqcGVnXCI7XG4gICAgICAgICAgICBlbHNlIGlmIChjdGwgPT09IDB4MEEpICBjbW9kZSA9IFwicG5nXCI7XG4gICAgICAgICAgICBlbHNlIGlmIChjdGwgJiAweDA0KSAgICBjbW9kZSA9IFwiZmlsdGVyXCI7XG4gICAgICAgICAgICBlbHNlIGlmIChjdGwgPCAweDA0KSAgICBjbW9kZSA9IFwiY29weVwiO1xuICAgICAgICAgICAgZWxzZSByZXR1cm4gdGhpcy5fZmFpbChcIklsbGVnYWwgdGlnaHQgY29tcHJlc3Npb24gcmVjZWl2ZWQsIGN0bDogXCIgKyBjdGwpO1xuXG4gICAgICAgICAgICBpZiAoaXNUaWdodFBORyAmJiAoY21vZGUgPT09IFwiZmlsdGVyXCIgfHwgY21vZGUgPT09IFwiY29weVwiKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiZmlsdGVyL2NvcHkgcmVjZWl2ZWQgaW4gdGlnaHRQTkcgbW9kZVwiKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3dpdGNoIChjbW9kZSkge1xuICAgICAgICAgICAgICAgIC8vIGZpbGwgdXNlIGZiX2RlcHRoIGJlY2F1c2UgVFBJWEVMcyBkcm9wIHRoZSBwYWRkaW5nIGJ5dGVcbiAgICAgICAgICAgICAgICBjYXNlIFwiZmlsbFwiOiAgLy8gVFBJWEVMXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyArPSB0aGlzLl9mYl9kZXB0aDtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSBcImpwZWdcIjogIC8vIG1heCBjbGVuZ3RoXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyArPSAzO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIFwicG5nXCI6ICAvLyBtYXggY2xlbmd0aFxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgKz0gMztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSBcImZpbHRlclwiOiAgLy8gZmlsdGVyIGlkICsgbnVtIGNvbG9ycyBpZiBwYWxldHRlXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyArPSAyO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIFwiY29weVwiOlxuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiVElHSFQgXCIgKyBjbW9kZSwgdGhpcy5fRkJVLmJ5dGVzKSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgLy8gRGV0ZXJtaW5lIEZCVS5ieXRlc1xuICAgICAgICAgICAgc3dpdGNoIChjbW9kZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgXCJmaWxsXCI6XG4gICAgICAgICAgICAgICAgICAgIC8vIHNraXAgY3RsIGJ5dGVcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5maWxsUmVjdCh0aGlzLl9GQlUueCwgdGhpcy5fRkJVLnksIHRoaXMuX0ZCVS53aWR0aCwgdGhpcy5fRkJVLmhlaWdodCwgW3JRW3JRaSArIDNdLCByUVtyUWkgKyAyXSwgclFbclFpICsgMV1dLCBmYWxzZSk7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwQnl0ZXMoNCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgXCJwbmdcIjpcbiAgICAgICAgICAgICAgICBjYXNlIFwianBlZ1wiOlxuICAgICAgICAgICAgICAgICAgICAvLyBiZWdpbiBpbmxpbmUgZ2V0VGlnaHRDTGVuZ3RoIChyZXR1cm5pbmcgdHdvLWl0ZW0gYXJyYXlzIGlzIGZvciBwZWZvcm1hbmNlIHdpdGggR0MpXG4gICAgICAgICAgICAgICAgICAgIHZhciBjbF9vZmZzZXQgPSByUWkgKyAxO1xuICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIgPSAxO1xuICAgICAgICAgICAgICAgICAgICBjbF9kYXRhID0gMDtcbiAgICAgICAgICAgICAgICAgICAgY2xfZGF0YSArPSByUVtjbF9vZmZzZXRdICYgMHg3ZjtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJRW2NsX29mZnNldF0gJiAweDgwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIrKztcbiAgICAgICAgICAgICAgICAgICAgICAgIGNsX2RhdGEgKz0gKHJRW2NsX29mZnNldCArIDFdICYgMHg3ZikgPDwgNztcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChyUVtjbF9vZmZzZXQgKyAxXSAmIDB4ODApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIrKztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbF9kYXRhICs9IHJRW2NsX29mZnNldCArIDJdIDw8IDE0O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIC8vIGVuZCBpbmxpbmUgZ2V0VGlnaHRDTGVuZ3RoXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDEgKyBjbF9oZWFkZXIgKyBjbF9kYXRhOyAgLy8gY3RsICsgY2xlbmd0aCBzaXplICsganBlZy1kYXRhXG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlRJR0hUIFwiICsgY21vZGUsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy8gV2UgaGF2ZSBldmVyeXRoaW5nLCByZW5kZXIgaXRcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygxICsgY2xfaGVhZGVyKTsgIC8vIHNoaWZ0IG9mZiBjbHQgKyBjb21wYWN0IGxlbmd0aFxuICAgICAgICAgICAgICAgICAgICB2YXIgaW1nID0gbmV3IEltYWdlKCk7XG4gICAgICAgICAgICAgICAgICAgIGltZy5zcmMgPSBcImRhdGE6IGltYWdlL1wiICsgY21vZGUgK1xuICAgICAgICAgICAgICAgICAgICAgICAgUkZCLmV4dHJhY3RfZGF0YV91cmkodGhpcy5fc29jay5yUXNoaWZ0Qnl0ZXMoY2xfZGF0YSkpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LnJlbmRlclFfcHVzaCh7XG4gICAgICAgICAgICAgICAgICAgICAgICAndHlwZSc6ICdpbWcnLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ2ltZyc6IGltZyxcbiAgICAgICAgICAgICAgICAgICAgICAgICd4JzogdGhpcy5fRkJVLngsXG4gICAgICAgICAgICAgICAgICAgICAgICAneSc6IHRoaXMuX0ZCVS55XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICBpbWcgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIFwiZmlsdGVyXCI6XG4gICAgICAgICAgICAgICAgICAgIHZhciBmaWx0ZXJJZCA9IHJRW3JRaSArIDFdO1xuICAgICAgICAgICAgICAgICAgICBpZiAoZmlsdGVySWQgPT09IDEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghaGFuZGxlUGFsZXR0ZSgpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gRmlsdGVyIDAsIENvcHkgY291bGQgYmUgdmFsaWQgaGVyZSwgYnV0IHNlcnZlcnMgZG9uJ3Qgc2VuZCBpdCBhcyBhbiBleHBsaWNpdCBmaWx0ZXJcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIEZpbHRlciAyLCBHcmFkaWVudCBpcyB2YWxpZCBidXQgbm90IHVzZSBpZiBqcGVnIGlzIGVuYWJsZWRcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZhaWwoXCJVbnN1cHBvcnRlZCB0aWdodCBzdWJlbmNvZGluZyByZWNlaXZlZCwgZmlsdGVyOiBcIiArIGZpbHRlcklkKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIFwiY29weVwiOlxuICAgICAgICAgICAgICAgICAgICBpZiAoIWhhbmRsZUNvcHkoKSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG5cblxuICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gMDtcbiAgICAgICAgICAgIHRoaXMuX0ZCVS5yZWN0cy0tO1xuXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBUSUdIVDogZnVuY3Rpb24gKCkgeyByZXR1cm4gdGhpcy5fZW5jSGFuZGxlcnMuZGlzcGxheV90aWdodChmYWxzZSk7IH0sXG4gICAgICAgIFRJR0hUX1BORzogZnVuY3Rpb24gKCkgeyByZXR1cm4gdGhpcy5fZW5jSGFuZGxlcnMuZGlzcGxheV90aWdodCh0cnVlKTsgfSxcblxuICAgICAgICBsYXN0X3JlY3Q6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHRoaXMuX0ZCVS5yZWN0cyA9IDA7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBoYW5kbGVfRkJfcmVzaXplOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB0aGlzLl9mYl93aWR0aCA9IHRoaXMuX0ZCVS53aWR0aDtcbiAgICAgICAgICAgIHRoaXMuX2ZiX2hlaWdodCA9IHRoaXMuX0ZCVS5oZWlnaHQ7XG4gICAgICAgICAgICB0aGlzLl9kZXN0QnVmZiA9IG5ldyBVaW50OEFycmF5KHRoaXMuX2ZiX3dpZHRoICogdGhpcy5fZmJfaGVpZ2h0ICogNCk7XG4gICAgICAgICAgICB0aGlzLl9kaXNwbGF5LnJlc2l6ZSh0aGlzLl9mYl93aWR0aCwgdGhpcy5fZmJfaGVpZ2h0KTtcbiAgICAgICAgICAgIHRoaXMuX29uRkJSZXNpemUodGhpcywgdGhpcy5fZmJfd2lkdGgsIHRoaXMuX2ZiX2hlaWdodCk7XG4gICAgICAgICAgICB0aGlzLl90aW1pbmcuZmJ1X3J0X3N0YXJ0ID0gKG5ldyBEYXRlKCkpLmdldFRpbWUoKTtcbiAgICAgICAgICAgIHRoaXMuX3VwZGF0ZUNvbnRpbnVvdXNVcGRhdGVzKCk7XG5cbiAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDA7XG4gICAgICAgICAgICB0aGlzLl9GQlUucmVjdHMgLT0gMTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIEV4dGVuZGVkRGVza3RvcFNpemU6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDE7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJFeHRlbmRlZERlc2t0b3BTaXplXCIsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgIHRoaXMuX3N1cHBvcnRzU2V0RGVza3RvcFNpemUgPSB0cnVlO1xuICAgICAgICAgICAgdmFyIG51bWJlcl9vZl9zY3JlZW5zID0gdGhpcy5fc29jay5yUXBlZWs4KCk7XG5cbiAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDQgKyAobnVtYmVyX29mX3NjcmVlbnMgKiAxNik7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJFeHRlbmRlZERlc2t0b3BTaXplXCIsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwQnl0ZXMoMSk7ICAvLyBudW1iZXItb2Ytc2NyZWVuc1xuICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygzKTsgIC8vIHBhZGRpbmdcblxuICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBudW1iZXJfb2Zfc2NyZWVuczsgaSArPSAxKSB7XG4gICAgICAgICAgICAgICAgLy8gU2F2ZSB0aGUgaWQgYW5kIGZsYWdzIG9mIHRoZSBmaXJzdCBzY3JlZW5cbiAgICAgICAgICAgICAgICBpZiAoaSA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9zY3JlZW5faWQgPSB0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyg0KTsgICAgLy8gaWRcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygyKTsgICAgICAgICAgICAgICAgICAgICAgIC8vIHgtcG9zaXRpb25cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygyKTsgICAgICAgICAgICAgICAgICAgICAgIC8vIHktcG9zaXRpb25cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygyKTsgICAgICAgICAgICAgICAgICAgICAgIC8vIHdpZHRoXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwQnl0ZXMoMik7ICAgICAgICAgICAgICAgICAgICAgICAvLyBoZWlnaHRcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc2NyZWVuX2ZsYWdzID0gdGhpcy5fc29jay5yUXNoaWZ0Qnl0ZXMoNCk7IC8vIGZsYWdzXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygxNik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKlxuICAgICAgICAgICAgICogVGhlIHgtcG9zaXRpb24gaW5kaWNhdGVzIHRoZSByZWFzb24gZm9yIHRoZSBjaGFuZ2U6XG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogIDAgLSBzZXJ2ZXIgcmVzaXplZCBvbiBpdHMgb3duXG4gICAgICAgICAgICAgKiAgMSAtIHRoaXMgY2xpZW50IHJlcXVlc3RlZCB0aGUgcmVzaXplXG4gICAgICAgICAgICAgKiAgMiAtIGFub3RoZXIgY2xpZW50IHJlcXVlc3RlZCB0aGUgcmVzaXplXG4gICAgICAgICAgICAgKi9cblxuICAgICAgICAgICAgLy8gV2UgbmVlZCB0byBoYW5kbGUgZXJyb3JzIHdoZW4gd2UgcmVxdWVzdGVkIHRoZSByZXNpemUuXG4gICAgICAgICAgICBpZiAodGhpcy5fRkJVLnggPT09IDEgJiYgdGhpcy5fRkJVLnkgIT09IDApIHtcbiAgICAgICAgICAgICAgICB2YXIgbXNnID0gXCJcIjtcbiAgICAgICAgICAgICAgICAvLyBUaGUgeS1wb3NpdGlvbiBpbmRpY2F0ZXMgdGhlIHN0YXR1cyBjb2RlIGZyb20gdGhlIHNlcnZlclxuICAgICAgICAgICAgICAgIHN3aXRjaCAodGhpcy5fRkJVLnkpIHtcbiAgICAgICAgICAgICAgICBjYXNlIDE6XG4gICAgICAgICAgICAgICAgICAgIG1zZyA9IFwiUmVzaXplIGlzIGFkbWluaXN0cmF0aXZlbHkgcHJvaGliaXRlZFwiO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIDI6XG4gICAgICAgICAgICAgICAgICAgIG1zZyA9IFwiT3V0IG9mIHJlc291cmNlc1wiO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIDM6XG4gICAgICAgICAgICAgICAgICAgIG1zZyA9IFwiSW52YWxpZCBzY3JlZW4gbGF5b3V0XCI7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIG1zZyA9IFwiVW5rbm93biByZWFzb25cIjtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFV0aWwuSW5mbyhcIlNlcnZlciBkaWQgbm90IGFjY2VwdCB0aGUgcmVzaXplIHJlcXVlc3Q6IFwiICsgbXNnKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhpcy5fZW5jSGFuZGxlcnMuaGFuZGxlX0ZCX3Jlc2l6ZSgpO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgRGVza3RvcFNpemU6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHRoaXMuX2VuY0hhbmRsZXJzLmhhbmRsZV9GQl9yZXNpemUoKTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIEN1cnNvcjogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIj4+IHNldF9jdXJzb3JcIik7XG4gICAgICAgICAgICB2YXIgeCA9IHRoaXMuX0ZCVS54OyAgLy8gaG90c3BvdC14XG4gICAgICAgICAgICB2YXIgeSA9IHRoaXMuX0ZCVS55OyAgLy8gaG90c3BvdC15XG4gICAgICAgICAgICB2YXIgdyA9IHRoaXMuX0ZCVS53aWR0aDtcbiAgICAgICAgICAgIHZhciBoID0gdGhpcy5fRkJVLmhlaWdodDtcblxuICAgICAgICAgICAgdmFyIHBpeGVsc2xlbmd0aCA9IHcgKiBoICogdGhpcy5fZmJfQnBwO1xuICAgICAgICAgICAgdmFyIG1hc2tsZW5ndGggPSBNYXRoLmZsb29yKCh3ICsgNykgLyA4KSAqIGg7XG5cbiAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IHBpeGVsc2xlbmd0aCArIG1hc2tsZW5ndGg7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJjdXJzb3IgZW5jb2RpbmdcIiwgdGhpcy5fRkJVLmJ5dGVzKSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5jaGFuZ2VDdXJzb3IodGhpcy5fc29jay5yUXNoaWZ0Qnl0ZXMocGl4ZWxzbGVuZ3RoKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suclFzaGlmdEJ5dGVzKG1hc2tsZW5ndGgpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeCwgeSwgdywgaCk7XG5cbiAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDA7XG4gICAgICAgICAgICB0aGlzLl9GQlUucmVjdHMtLTtcblxuICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIjw8IHNldF9jdXJzb3JcIik7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBRRU1VRXh0ZW5kZWRLZXlFdmVudDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdGhpcy5fRkJVLnJlY3RzLS07XG5cbiAgICAgICAgICAgIHZhciBrZXlib2FyZEV2ZW50ID0gZG9jdW1lbnQuY3JlYXRlRXZlbnQoXCJrZXlib2FyZEV2ZW50XCIpO1xuICAgICAgICAgICAgaWYgKGtleWJvYXJkRXZlbnQuY29kZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fcWVtdUV4dEtleUV2ZW50U3VwcG9ydGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICB0aGlzLl9rZXlib2FyZC5zZXRRRU1VVk5DS2V5Ym9hcmRIYW5kbGVyKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgSlBFR19xdWFsaXR5X2xvOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBVdGlsLkVycm9yKFwiU2VydmVyIHNlbnQganBlZ19xdWFsaXR5IHBzZXVkby1lbmNvZGluZ1wiKTtcbiAgICAgICAgfSxcblxuICAgICAgICBjb21wcmVzc19sbzogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgVXRpbC5FcnJvcihcIlNlcnZlciBzZW50IGNvbXByZXNzIGxldmVsIHBzZXVkby1lbmNvZGluZ1wiKTtcbiAgICAgICAgfVxuICAgIH07XG59KSgpO1xuIl19