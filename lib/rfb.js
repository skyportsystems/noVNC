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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInJmYi5qcyJdLCJuYW1lcyI6WyJSRkIiLCJkZWZhdWx0cyIsIl9yZmJfaG9zdCIsIl9yZmJfcG9ydCIsIl9yZmJfcGFzc3dvcmQiLCJfcmZiX3BhdGgiLCJfcmZiX3N0YXRlIiwiX3JmYl92ZXJzaW9uIiwiX3JmYl9tYXhfdmVyc2lvbiIsIl9yZmJfYXV0aF9zY2hlbWUiLCJfcmZiX3RpZ2h0dm5jIiwiX3JmYl94dnBfdmVyIiwiX2VuY29kaW5ncyIsIl9lbmNIYW5kbGVycyIsIl9lbmNOYW1lcyIsIl9lbmNTdGF0cyIsIl9zb2NrIiwiX2Rpc3BsYXkiLCJfa2V5Ym9hcmQiLCJfbW91c2UiLCJfZGlzY29ublRpbWVyIiwiX21zZ1RpbWVyIiwiX3N1cHBvcnRzRmVuY2UiLCJfc3VwcG9ydHNDb250aW51b3VzVXBkYXRlcyIsIl9lbmFibGVkQ29udGludW91c1VwZGF0ZXMiLCJfRkJVIiwicmVjdHMiLCJzdWJyZWN0cyIsImxpbmVzIiwidGlsZXMiLCJieXRlcyIsIngiLCJ5Iiwid2lkdGgiLCJoZWlnaHQiLCJlbmNvZGluZyIsInN1YmVuY29kaW5nIiwiYmFja2dyb3VuZCIsInpsaWIiLCJfZmJfQnBwIiwiX2ZiX2RlcHRoIiwiX2ZiX3dpZHRoIiwiX2ZiX2hlaWdodCIsIl9mYl9uYW1lIiwiX2Rlc3RCdWZmIiwiX3BhbGV0dGVCdWZmIiwiVWludDhBcnJheSIsIl9ycmVfY2h1bmtfc3oiLCJfdGltaW5nIiwibGFzdF9mYnUiLCJmYnVfdG90YWwiLCJmYnVfdG90YWxfY250IiwiZnVsbF9mYnVfdG90YWwiLCJmdWxsX2ZidV9jbnQiLCJmYnVfcnRfc3RhcnQiLCJmYnVfcnRfdG90YWwiLCJmYnVfcnRfY250IiwicGl4ZWxzIiwiX3N1cHBvcnRzU2V0RGVza3RvcFNpemUiLCJfc2NyZWVuX2lkIiwiX3NjcmVlbl9mbGFncyIsIl9tb3VzZV9idXR0b25NYXNrIiwiX21vdXNlX2FyciIsIl92aWV3cG9ydERyYWdnaW5nIiwiX3ZpZXdwb3J0RHJhZ1BvcyIsIl92aWV3cG9ydEhhc01vdmVkIiwiX3FlbXVFeHRLZXlFdmVudFN1cHBvcnRlZCIsInNldF9kZWZhdWx0cyIsImRvY3VtZW50IiwiRGVidWciLCJPYmplY3QiLCJrZXlzIiwiZW5jb2RpbmdIYW5kbGVycyIsImZvckVhY2giLCJlbmNOYW1lIiwiYmluZCIsImkiLCJsZW5ndGgiLCJ0YXJnZXQiLCJfdGFyZ2V0IiwiZXhjIiwiRXJyb3IiLCJfZm9jdXNDb250YWluZXIiLCJvbktleVByZXNzIiwiX2hhbmRsZUtleVByZXNzIiwib25Nb3VzZUJ1dHRvbiIsIl9oYW5kbGVNb3VzZUJ1dHRvbiIsIm9uTW91c2VNb3ZlIiwiX2hhbmRsZU1vdXNlTW92ZSIsIm5vdGlmeSIsInN5bmMiLCJvbiIsIl9oYW5kbGVfbWVzc2FnZSIsIl91cGRhdGVTdGF0ZSIsIl9mYWlsIiwiZSIsIldhcm4iLCJtc2ciLCJjb2RlIiwicmVhc29uIiwib2ZmIiwiX2luaXRfdmFycyIsInJtb2RlIiwiZ2V0X3JlbmRlcl9tb2RlIiwiSW5mbyIsInByb3RvdHlwZSIsImNvbm5lY3QiLCJob3N0IiwicG9ydCIsInBhc3N3b3JkIiwicGF0aCIsInVuZGVmaW5lZCIsImRpc2Nvbm5lY3QiLCJzZW5kUGFzc3dvcmQiLCJwYXNzd2QiLCJzZXRUaW1lb3V0IiwiX2luaXRfbXNnIiwic2VuZEN0cmxBbHREZWwiLCJfdmlld19vbmx5IiwibWVzc2FnZXMiLCJrZXlFdmVudCIsIlhLX0NvbnRyb2xfTCIsIlhLX0FsdF9MIiwiWEtfRGVsZXRlIiwieHZwT3AiLCJ2ZXIiLCJvcCIsInNlbmRfc3RyaW5nIiwiU3RyaW5nIiwiZnJvbUNoYXJDb2RlIiwieHZwU2h1dGRvd24iLCJ4dnBSZWJvb3QiLCJ4dnBSZXNldCIsInNlbmRLZXkiLCJkb3duIiwiY2xpcGJvYXJkUGFzdGVGcm9tIiwidGV4dCIsImNsaWVudEN1dFRleHQiLCJyZXF1ZXN0RGVza3RvcFNpemUiLCJzZXREZXNrdG9wU2l6ZSIsImZsdXNoIiwiX2Nvbm5lY3QiLCJ1cmkiLCJVc2luZ1NvY2tldElPIiwiX2VuY3J5cHQiLCJvcGVuIiwiX3dzUHJvdG9jb2xzIiwiemxpYnMiLCJJbmZsYXRlIiwiX3ByaW50X3N0YXRzIiwicyIsIl9jbGVhbnVwU29ja2V0Iiwic3RhdGUiLCJjbGVhckludGVydmFsIiwiZ2V0X2NvbnRleHQiLCJ1bmdyYWIiLCJkZWZhdWx0Q3Vyc29yIiwiZ2V0X2xvZ2dpbmciLCJjbGVhciIsImNsb3NlIiwic3RhdHVzTXNnIiwib2xkc3RhdGUiLCJjbXNnIiwiZnVsbG1zZyIsImNsZWFyVGltZW91dCIsIl9kaXNjb25uZWN0VGltZW91dCIsIl9vblVwZGF0ZVN0YXRlIiwiclFsZW4iLCJfbm9ybWFsX21zZyIsImtleWV2ZW50IiwidHlwZSIsInNjYW5jb2RlIiwia2V5c3ltIiwiUUVNVUV4dGVuZGVkS2V5RXZlbnQiLCJibWFzayIsIl92aWV3cG9ydERyYWciLCJwb2ludGVyRXZlbnQiLCJhYnNYIiwiYWJzWSIsImRlbHRhWCIsImRlbHRhWSIsImRyYWdUaHJlc2hvbGQiLCJ3aW5kb3ciLCJkZXZpY2VQaXhlbFJhdGlvIiwiTWF0aCIsImFicyIsInZpZXdwb3J0Q2hhbmdlUG9zIiwiX25lZ290aWF0ZV9wcm90b2NvbF92ZXJzaW9uIiwic3ZlcnNpb24iLCJyUXNoaWZ0U3RyIiwic3Vic3RyIiwiaXNfcmVwZWF0ZXIiLCJyZXBlYXRlcklEIiwiX3JlcGVhdGVySUQiLCJjdmVyc2lvbiIsInBhcnNlSW50IiwiX25lZ290aWF0ZV9zZWN1cml0eSIsIm51bV90eXBlcyIsInJRc2hpZnQ4IiwiclF3YWl0Iiwic3RybGVuIiwiclFzaGlmdDMyIiwidHlwZXMiLCJyUXNoaWZ0Qnl0ZXMiLCJzZW5kIiwiX25lZ290aWF0ZV94dnBfYXV0aCIsInh2cF9zZXAiLCJfeHZwX3Bhc3N3b3JkX3NlcCIsInh2cF9hdXRoIiwic3BsaXQiLCJfb25QYXNzd29yZFJlcXVpcmVkIiwieHZwX2F1dGhfc3RyIiwic2xpY2UiLCJqb2luIiwiX25lZ290aWF0ZV9hdXRoZW50aWNhdGlvbiIsIl9uZWdvdGlhdGVfc3RkX3ZuY19hdXRoIiwiY2hhbGxlbmdlIiwiQXJyYXkiLCJjYWxsIiwicmVzcG9uc2UiLCJnZW5ERVMiLCJfbmVnb3RpYXRlX3RpZ2h0X3R1bm5lbHMiLCJudW1UdW5uZWxzIiwiY2xpZW50U3VwcG9ydGVkVHVubmVsVHlwZXMiLCJ2ZW5kb3IiLCJzaWduYXR1cmUiLCJzZXJ2ZXJTdXBwb3J0ZWRUdW5uZWxUeXBlcyIsImNhcF9jb2RlIiwiY2FwX3ZlbmRvciIsImNhcF9zaWduYXR1cmUiLCJfbmVnb3RpYXRlX3RpZ2h0X2F1dGgiLCJzdWJBdXRoQ291bnQiLCJjbGllbnRTdXBwb3J0ZWRUeXBlcyIsInNlcnZlclN1cHBvcnRlZFR5cGVzIiwiY2FwTnVtIiwiY2FwYWJpbGl0aWVzIiwicHVzaCIsImF1dGhUeXBlIiwiaW5kZXhPZiIsIl9oYW5kbGVfc2VjdXJpdHlfcmVzdWx0IiwiX25lZ290aWF0ZV9zZXJ2ZXJfaW5pdCIsInJRc2hpZnQxNiIsImJwcCIsImRlcHRoIiwiYmlnX2VuZGlhbiIsInRydWVfY29sb3IiLCJyZWRfbWF4IiwiZ3JlZW5fbWF4IiwiYmx1ZV9tYXgiLCJyZWRfc2hpZnQiLCJncmVlbl9zaGlmdCIsImJsdWVfc2hpZnQiLCJyUXNraXBCeXRlcyIsIm5hbWVfbGVuZ3RoIiwiZGVjb2RlVVRGOCIsIm51bVNlcnZlck1lc3NhZ2VzIiwibnVtQ2xpZW50TWVzc2FnZXMiLCJudW1FbmNvZGluZ3MiLCJ0b3RhbE1lc3NhZ2VzTGVuZ3RoIiwiX29uRGVza3RvcE5hbWUiLCJfdHJ1ZV9jb2xvciIsInNldF90cnVlX2NvbG9yIiwicmVzaXplIiwiX29uRkJSZXNpemUiLCJncmFiIiwicGl4ZWxGb3JtYXQiLCJjbGllbnRFbmNvZGluZ3MiLCJfbG9jYWxfY3Vyc29yIiwiZmJVcGRhdGVSZXF1ZXN0cyIsImdldENsZWFuRGlydHlSZXNldCIsIkRhdGUiLCJnZXRUaW1lIiwiX3NoYXJlZCIsIl9oYW5kbGVfc2V0X2NvbG91cl9tYXBfbXNnIiwiclFza2lwOCIsImZpcnN0X2NvbG91ciIsIm51bV9jb2xvdXJzIiwiYyIsInJlZCIsImdyZWVuIiwiYmx1ZSIsInNldF9jb2xvdXJNYXAiLCJnZXRfY29sb3VyTWFwIiwiX2hhbmRsZV9zZXJ2ZXJfY3V0X3RleHQiLCJfb25DbGlwYm9hcmQiLCJfaGFuZGxlX3NlcnZlcl9mZW5jZV9tc2ciLCJmbGFncyIsInBheWxvYWQiLCJjbGllbnRGZW5jZSIsIl9oYW5kbGVfeHZwX21zZyIsInh2cF92ZXIiLCJ4dnBfbXNnIiwiX29uWHZwSW5pdCIsIm1zZ190eXBlIiwicmV0IiwiX2ZyYW1lYnVmZmVyVXBkYXRlIiwiX29uQmVsbCIsImZpcnN0IiwiX3VwZGF0ZUNvbnRpbnVvdXNVcGRhdGVzIiwiclFzbGljZSIsIm5vdyIsImN1cl9mYnUiLCJoZHIiLCJfb25GQlVSZWNlaXZlIiwiZmJ1X3J0X2RpZmYiLCJfb25GQlVDb21wbGV0ZSIsImVuYWJsZUNvbnRpbnVvdXNVcGRhdGVzIiwibWFrZV9wcm9wZXJ0aWVzIiwic2V0X2xvY2FsX2N1cnNvciIsImN1cnNvciIsImRpc2FibGVMb2NhbEN1cnNvciIsImdldF9jdXJzb3JfdXJpIiwiZ2V0X2Rpc3BsYXkiLCJnZXRfa2V5Ym9hcmQiLCJnZXRfbW91c2UiLCJzb2NrIiwiYnVmZiIsIl9zUSIsIm9mZnNldCIsIl9zUWxlbiIsImtleWNvZGUiLCJnZXRSRkJrZXljb2RlIiwieHRfc2NhbmNvZGUiLCJ1cHBlckJ5dGUiLCJsb3dlckJ5dGUiLCJSRkJrZXljb2RlIiwibWFzayIsIm4iLCJjaGFyQ29kZUF0IiwiaWQiLCJlbmFibGUiLCJlbmNvZGluZ3MiLCJsb2NhbF9jdXJzb3IiLCJqIiwiY250IiwiZW5jIiwib25seU5vbkluYyIsImNsZWFuRGlydHkiLCJmYl93aWR0aCIsImZiX2hlaWdodCIsIm9mZnNldEluY3JlbWVudCIsImNiIiwiY2xlYW5Cb3giLCJ3IiwiaCIsImZiVXBkYXRlUmVxdWVzdCIsImRpcnR5Qm94ZXMiLCJkYiIsImluY3JlbWVudGFsIiwiZW5jcnlwdCIsImV4dHJhY3RfZGF0YV91cmkiLCJhcnIiLCJlbmNvZGUiLCJSQVciLCJjdXJfeSIsImN1cnJfaGVpZ2h0IiwibWluIiwiZmxvb3IiLCJibGl0SW1hZ2UiLCJnZXRfclEiLCJnZXRfclFpIiwiQ09QWVJFQ1QiLCJjb3B5SW1hZ2UiLCJSUkUiLCJjb2xvciIsImZpbGxSZWN0IiwiY2h1bmsiLCJIRVhUSUxFIiwiclEiLCJyUWkiLCJ0aWxlc194IiwiY2VpbCIsInRpbGVzX3kiLCJ0b3RhbF90aWxlcyIsImN1cnJfdGlsZSIsInRpbGVfeCIsInRpbGVfeSIsImxhc3RzdWJlbmNvZGluZyIsImZvcmVncm91bmQiLCJzdGFydFRpbGUiLCJ4eSIsInN4Iiwic3kiLCJ3aCIsInN3Iiwic2giLCJzdWJUaWxlIiwiZmluaXNoVGlsZSIsInNldF9yUWkiLCJnZXRUaWdodENMZW5ndGgiLCJoZWFkZXIiLCJkYXRhIiwiZGlzcGxheV90aWdodCIsImlzVGlnaHRQTkciLCJjaGVja3N1bSIsInN1bSIsInJlc2V0U3RyZWFtcyIsInN0cmVhbUlkIiwiZGVjb21wcmVzcyIsImV4cGVjdGVkIiwicmVzZXQiLCJ1bmNvbXByZXNzZWQiLCJpbmZsYXRlIiwiaW5kZXhlZFRvUkdCWDJDb2xvciIsInBhbGV0dGUiLCJkZXN0IiwidzEiLCJiIiwiZHAiLCJzcCIsImluZGV4ZWRUb1JHQlgiLCJ0b3RhbCIsInJRd2hvbGUiLCJjbW9kZSIsImNsX2hlYWRlciIsImNsX2RhdGEiLCJoYW5kbGVQYWxldHRlIiwibnVtQ29sb3JzIiwicGFsZXR0ZVNpemUiLCJyb3dTaXplIiwicmF3IiwiY2xfb2Zmc2V0IiwiclFzaGlmdFRvIiwicmdieCIsImJsaXRSZ2J4SW1hZ2UiLCJoYW5kbGVDb3B5IiwidW5jb21wcmVzc2VkU2l6ZSIsImJsaXRSZ2JJbWFnZSIsImN0bCIsInJRcGVlazgiLCJpbWciLCJJbWFnZSIsInNyYyIsInJlbmRlclFfcHVzaCIsImZpbHRlcklkIiwiVElHSFQiLCJUSUdIVF9QTkciLCJsYXN0X3JlY3QiLCJoYW5kbGVfRkJfcmVzaXplIiwiRXh0ZW5kZWREZXNrdG9wU2l6ZSIsIm51bWJlcl9vZl9zY3JlZW5zIiwiRGVza3RvcFNpemUiLCJDdXJzb3IiLCJwaXhlbHNsZW5ndGgiLCJtYXNrbGVuZ3RoIiwiY2hhbmdlQ3Vyc29yIiwia2V5Ym9hcmRFdmVudCIsImNyZWF0ZUV2ZW50Iiwic2V0UUVNVVZOQ0tleWJvYXJkSGFuZGxlciIsIkpQRUdfcXVhbGl0eV9sbyIsImNvbXByZXNzX2xvIl0sIm1hcHBpbmdzIjoiOzs7OztrQkF5QndCQSxHOztBQWJ4Qjs7OztBQUNBOzs7O0FBQ0E7O0FBQ0E7Ozs7QUFDQTs7OztBQUNBOzs7O0FBQ0E7Ozs7QUFDQTs7OztBQUNBOzs7Ozs7QUFFQTtBQUNBOztBQUVlLFNBQVNBLEdBQVQsQ0FBYUMsUUFBYixFQUF1QjtBQUNsQzs7QUFDQSxRQUFJLENBQUNBLFFBQUwsRUFBZTtBQUNYQSxtQkFBVyxFQUFYO0FBQ0g7O0FBRUQsU0FBS0MsU0FBTCxHQUFpQixFQUFqQjtBQUNBLFNBQUtDLFNBQUwsR0FBaUIsSUFBakI7QUFDQSxTQUFLQyxhQUFMLEdBQXFCLEVBQXJCO0FBQ0EsU0FBS0MsU0FBTCxHQUFpQixFQUFqQjs7QUFFQSxTQUFLQyxVQUFMLEdBQWtCLGNBQWxCO0FBQ0EsU0FBS0MsWUFBTCxHQUFvQixDQUFwQjtBQUNBLFNBQUtDLGdCQUFMLEdBQXdCLEdBQXhCO0FBQ0EsU0FBS0MsZ0JBQUwsR0FBd0IsRUFBeEI7O0FBRUEsU0FBS0MsYUFBTCxHQUFxQixLQUFyQjtBQUNBLFNBQUtDLFlBQUwsR0FBb0IsQ0FBcEI7O0FBRUE7QUFDQSxTQUFLQyxVQUFMLEdBQWtCLENBQ2QsQ0FBQyxVQUFELEVBQXlCLElBQXpCLENBRGMsRUFFZCxDQUFDLE9BQUQsRUFBeUIsSUFBekIsQ0FGYyxFQUdkLENBQUMsV0FBRCxFQUF5QixDQUFDLEdBQTFCLENBSGMsRUFJZCxDQUFDLFNBQUQsRUFBeUIsSUFBekIsQ0FKYyxFQUtkLENBQUMsS0FBRCxFQUF5QixJQUF6QixDQUxjLEVBTWQsQ0FBQyxLQUFELEVBQXlCLElBQXpCLENB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Z0JBQUlELGNBQWM1VixJQUFkLEtBQXVCYSxTQUEzQixFQUFzQztBQUNsQyxxQkFBSzdDLHlCQUFMLEdBQWlDLElBQWpDO0FBQ0EscUJBQUtoRCxTQUFMLENBQWU4YSx5QkFBZjtBQUNIO0FBQ0osU0Evb0JrQjs7QUFpcEJuQkMseUJBQWlCLFlBQVk7QUFDekIsMkJBQUtoWCxLQUFMLENBQVcsMENBQVg7QUFDSCxTQW5wQmtCOztBQXFwQm5CaVgscUJBQWEsWUFBWTtBQUNyQiwyQkFBS2pYLEtBQUwsQ0FBVyw0Q0FBWDtBQUNIO0FBdnBCa0IsS0FBdkI7QUF5cEJILENBM2lFRCIsImZpbGUiOiJyZmIuanMiLCJzb3VyY2VzQ29udGVudCI6WyIvKlxuICogbm9WTkM6IEhUTUw1IFZOQyBjbGllbnRcbiAqIENvcHlyaWdodCAoQykgMjAxMiBKb2VsIE1hcnRpblxuICogQ29weXJpZ2h0IChDKSAyMDE2IFNhbXVlbCBNYW5uZWhlZCBmb3IgQ2VuZGlvIEFCXG4gKiBMaWNlbnNlZCB1bmRlciBNUEwgMi4wIChzZWUgTElDRU5TRS50eHQpXG4gKlxuICogU2VlIFJFQURNRS5tZCBmb3IgdXNhZ2UgYW5kIGludGVncmF0aW9uIGluc3RydWN0aW9ucy5cbiAqXG4gKiBUSUdIVCBkZWNvZGVyIHBvcnRpb246XG4gKiAoYykgMjAxMiBNaWNoYWVsIFRpbmdsb2YsIEpvZSBCYWxheiwgTGVzIFBpZWNoIChNZXJjdXJpLmNhKVxuICovXG5cbmltcG9ydCBVdGlsIGZyb20gXCIuL3V0aWxcIjtcbmltcG9ydCBEaXNwbGF5IGZyb20gXCIuL2Rpc3BsYXlcIjtcbmltcG9ydCB7IEtleWJvYXJkLCBNb3VzZSB9IGZyb20gXCIuL2lucHV0L2RldmljZXNcIlxuaW1wb3J0IFdlYnNvY2sgZnJvbSBcIi4vd2Vic29ja1wiXG5pbXBvcnQgQmFzZTY0IGZyb20gXCIuL2Jhc2U2NFwiO1xuaW1wb3J0IERFUyBmcm9tIFwiLi9kZXNcIjtcbmltcG9ydCBLZXlUYWJsZSBmcm9tIFwiLi9pbnB1dC9rZXlzeW1cIjtcbmltcG9ydCBYdFNjYW5jb2RlIGZyb20gXCIuL2lucHV0L3h0c2NhbmNvZGVzXCI7XG5pbXBvcnQgSW5mbGF0b3IgZnJvbSBcIi4vaW5mbGF0b3IubW9kXCI7XG5cbi8qanNsaW50IHdoaXRlOiBmYWxzZSwgYnJvd3NlcjogdHJ1ZSAqL1xuLypnbG9iYWwgd2luZG93LCBVdGlsLCBEaXNwbGF5LCBLZXlib2FyZCwgTW91c2UsIFdlYnNvY2ssIFdlYnNvY2tfbmF0aXZlLCBCYXNlNjQsIERFUywgS2V5VGFibGUsIEluZmxhdG9yLCBYdFNjYW5jb2RlICovXG5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIFJGQihkZWZhdWx0cykge1xuICAgIFwidXNlIHN0cmljdFwiO1xuICAgIGlmICghZGVmYXVsdHMpIHtcbiAgICAgICAgZGVmYXVsdHMgPSB7fTtcbiAgICB9XG5cbiAgICB0aGlzLl9yZmJfaG9zdCA9ICcnO1xuICAgIHRoaXMuX3JmYl9wb3J0ID0gNTkwMDtcbiAgICB0aGlzLl9yZmJfcGFzc3dvcmQgPSAnJztcbiAgICB0aGlzLl9yZmJfcGF0aCA9ICcnO1xuXG4gICAgdGhpcy5fcmZiX3N0YXRlID0gJ2Rpc2Nvbm5lY3RlZCc7XG4gICAgdGhpcy5fcmZiX3ZlcnNpb24gPSAwO1xuICAgIHRoaXMuX3JmYl9tYXhfdmVyc2lvbiA9IDMuODtcbiAgICB0aGlzLl9yZmJfYXV0aF9zY2hlbWUgPSAnJztcblxuICAgIHRoaXMuX3JmYl90aWdodHZuYyA9IGZhbHNlO1xuICAgIHRoaXMuX3JmYl94dnBfdmVyID0gMDtcblxuICAgIC8vIEluIHByZWZlcmVuY2Ugb3JkZXJcbiAgICB0aGlzLl9lbmNvZGluZ3MgPSBbXG4gICAgICAgIFsnQ09QWVJFQ1QnLCAgICAgICAgICAgICAweDAxIF0sXG4gICAgICAgIFsnVElHSFQnLCAgICAgICAgICAgICAgICAweDA3IF0sXG4gICAgICAgIFsnVElHSFRfUE5HJywgICAgICAgICAgICAtMjYwIF0sXG4gICAgICAgIFsnSEVYVElMRScsICAgICAgICAgICAgICAweDA1IF0sXG4gICAgICAgIFsnUlJFJywgICAgICAgICAgICAgICAgICAweDAyIF0sXG4gICAgICAgIFsnUkFXJywgICAgICAgICAgICAgICAgICAweDAwIF0sXG5cbiAgICAgICAgLy8gUHN1ZWRvLWVuY29kaW5nIHNldHRpbmdzXG5cbiAgICAgICAgLy9bJ0pQRUdfcXVhbGl0eV9sbycsICAgICAtMzIgXSxcbiAgICAgICAgLy9bJ0pQRUdfcXVhbGl0eV9tZWQnLCAgICAgIC0yNiBdLFxuICAgICAgICAvL1snSlBFR19xdWFsaXR5X2hpJywgICAgIC0yMyBdLFxuICAgICAgICAvL1snY29tcHJlc3NfbG8nLCAgICAgICAgLTI1NSBdLFxuICAgICAgICAvL1snY29tcHJlc3NfaGknLCAgICAgICAgICAtMjQ3IF0sXG5cbiAgICAgICAgWydEZXNrdG9wU2l6ZScsICAgICAgICAgIC0yMjMgXSxcbiAgICAgICAgWydsYXN0X3JlY3QnLCAgICAgICAgICAgIC0yMjQgXSxcbiAgICAgICAgWydDdXJzb3InLCAgICAgICAgICAgICAgIC0yMzkgXSxcbiAgICAgICAgWydRRU1VRXh0ZW5kZWRLZXlFdmVudCcsIC0yNTggXSxcbiAgICAgICAgWydFeHRlbmRlZERlc2t0b3BTaXplJywgIC0zMDggXVxuICAgICAgICAvL1sneHZwJywgICAgICAgICAgICAgICAgICAtMzA5IF0sIC8vIE5vbmUgb2YgdGhlc2UgaGF2ZSBhY3R1YWxseSBiZWVuIGltcGxlbWVudGVkLiBBZHZlcnRpc2luZyB0aGlzIHRvXG4gICAgICAgIC8vWydGZW5jZScsICAgICAgICAgICAgICAgIC0zMTIgXSwgLy8gYSBWTkMgc2VydmVyIHRoYXQgc3VwcG9ydHMgdGhlc2UgZXh0ZW5zaW9ucyByZXN1bHRzIGluIGltbWVkaWF0ZVxuICAgICAgICAvL1snQ29udGludW91c1VwZGF0ZXMnLCAgICAtMzEzIF0gIC8vIGFja25vd2xlZGdlbWVudCBhcyBwc2V1ZG8tZW5jb2RlZCByZWN0YW5nbGVzIGFuZCBkZXN5bmNpbmcgdGhlIGNsaWVudC5cbiAgICBdO1xuXG4gICAgdGhpcy5fZW5jSGFuZGxlcnMgPSB7fTtcbiAgICB0aGlzLl9lbmNOYW1lcyA9IHt9O1xuICAgIHRoaXMuX2VuY1N0YXRzID0ge307XG5cbiAgICB0aGlzLl9zb2NrID0gbnVsbDsgICAgICAgICAgICAgIC8vIFdlYnNvY2sgb2JqZWN0XG4gICAgdGhpcy5fZGlzcGxheSA9IG51bGw7ICAgICAgICAgICAvLyBEaXNwbGF5IG9iamVjdFxuICAgIHRoaXMuX2tleWJvYXJkID0gbnVsbDsgICAgICAgICAgLy8gS2V5Ym9hcmQgaW5wdXQgaGFuZGxlciBvYmplY3RcbiAgICB0aGlzLl9tb3VzZSA9IG51bGw7ICAgICAgICAgICAgIC8vIE1vdXNlIGlucHV0IGhhbmRsZXIgb2JqZWN0XG4gICAgdGhpcy5fZGlzY29ublRpbWVyID0gbnVsbDsgICAgICAvLyBkaXNjb25uZWN0aW9uIHRpbWVyXG4gICAgdGhpcy5fbXNnVGltZXIgPSBudWxsOyAgICAgICAgICAvLyBxdWV1ZWQgaGFuZGxlX21zZyB0aW1lclxuXG4gICAgdGhpcy5fc3VwcG9ydHNGZW5jZSA9IGZhbHNlO1xuXG4gICAgdGhpcy5fc3VwcG9ydHNDb250aW51b3VzVXBkYXRlcyA9IGZhbHNlO1xuICAgIHRoaXMuX2VuYWJsZWRDb250aW51b3VzVXBkYXRlcyA9IGZhbHNlO1xuXG4gICAgLy8gRnJhbWUgYnVmZmVyIHVwZGF0ZSBzdGF0ZVxuICAgIHRoaXMuX0ZCVSA9IHtcbiAgICAgICAgcmVjdHM6IDAsXG4gICAgICAgIHN1YnJlY3RzOiAwLCAgICAgICAgICAgIC8vIFJSRVxuICAgICAgICBsaW5lczogMCwgICAgICAgICAgICAgICAvLyBSQVdcbiAgICAgICAgdGlsZXM6IDAsICAgICAgICAgICAgICAgLy8gSEVYVElMRVxuICAgICAgICBieXRlczogMCxcbiAgICAgICAgeDogMCxcbiAgICAgICAgeTogMCxcbiAgICAgICAgd2lkdGg6IDAsXG4gICAgICAgIGhlaWdodDogMCxcbiAgICAgICAgZW5jb2Rpbmc6IDAsXG4gICAgICAgIHN1YmVuY29kaW5nOiAtMSxcbiAgICAgICAgYmFja2dyb3VuZDogbnVsbCxcbiAgICAgICAgemxpYjogW10gICAgICAgICAgICAgICAgLy8gVElHSFQgemxpYiBzdHJlYW1zXG4gICAgfTtcblxuICAgIHRoaXMuX2ZiX0JwcCA9IDQ7XG4gICAgdGhpcy5fZmJfZGVwdGggPSAzO1xuICAgIHRoaXMuX2ZiX3dpZHRoID0gMDtcbiAgICB0aGlzLl9mYl9oZWlnaHQgPSAwO1xuICAgIHRoaXMuX2ZiX25hbWUgPSBcIlwiO1xuXG4gICAgdGhpcy5fZGVzdEJ1ZmYgPSBudWxsO1xuICAgIHRoaXMuX3BhbGV0dGVCdWZmID0gbmV3IFVpbnQ4QXJyYXkoMTAyNCk7ICAvLyAyNTYgKiA0IChtYXggcGFsZXR0ZSBzaXplICogbWF4IGJ5dGVzLXBlci1waXhlbClcblxuICAgIHRoaXMuX3JyZV9jaHVua19zeiA9IDEwMDtcblxuICAgIHRoaXMuX3RpbWluZyA9IHtcbiAgICAgICAgbGFzdF9mYnU6IDAsXG4gICAgICAgIGZidV90b3RhbDogMCxcbiAgICAgICAgZmJ1X3RvdGFsX2NudDogMCxcbiAgICAgICAgZnVsbF9mYnVfdG90YWw6IDAsXG4gICAgICAgIGZ1bGxfZmJ1X2NudDogMCxcblxuICAgICAgICBmYnVfcnRfc3RhcnQ6IDAsXG4gICAgICAgIGZidV9ydF90b3RhbDogMCxcbiAgICAgICAgZmJ1X3J0X2NudDogMCxcbiAgICAgICAgcGl4ZWxzOiAwXG4gICAgfTtcblxuICAgIHRoaXMuX3N1cHBvcnRzU2V0RGVza3RvcFNpemUgPSBmYWxzZTtcbiAgICB0aGlzLl9zY3JlZW5faWQgPSAwO1xuICAgIHRoaXMuX3NjcmVlbl9mbGFncyA9IDA7XG5cbiAgICAvLyBNb3VzZSBzdGF0ZVxuICAgIHRoaXMuX21vdXNlX2J1dHRvbk1hc2sgPSAwO1xuICAgIHRoaXMuX21vdXNlX2FyciA9IFtdO1xuICAgIHRoaXMuX3ZpZXdwb3J0RHJhZ2dpbmcgPSBmYWxzZTtcbiAgICB0aGlzLl92aWV3cG9ydERyYWdQb3MgPSB7fTtcbiAgICB0aGlzLl92aWV3cG9ydEhhc01vdmVkID0gZmFsc2U7XG5cbiAgICAvLyBRRU1VIEV4dGVuZGVkIEtleSBFdmVudCBzdXBwb3J0IC0gZGVmYXVsdCB0byBmYWxzZVxuICAgIHRoaXMuX3FlbXVFeHRLZXlFdmVudFN1cHBvcnRlZCA9IGZhbHNlO1xuXG4gICAgLy8gc2V0IHRoZSBkZWZhdWx0IHZhbHVlIG9uIHVzZXItZmFjaW5nIHByb3BlcnRpZXNcbiAgICBVdGlsLnNldF9kZWZhdWx0cyh0aGlzLCBkZWZhdWx0cywge1xuICAgICAgICAndGFyZ2V0JzogJ251bGwnLCAgICAgICAgICAgICAgICAgICAgICAgLy8gVk5DIGRpc3BsYXkgcmVuZGVyaW5nIENhbnZhcyBvYmplY3RcbiAgICAgICAgJ2ZvY3VzQ29udGFpbmVyJzogZG9jdW1lbnQsICAgICAgICAgICAgIC8vIERPTSBlbGVtZW50IHRoYXQgY2FwdHVyZXMga2V5Ym9hcmQgaW5wdXRcbiAgICAgICAgJ2VuY3J5cHQnOiBmYWxzZSwgICAgICAgICAgICAgICAgICAgICAgIC8vIFVzZSBUTFMvU1NML3dzcyBlbmNyeXB0aW9uXG4gICAgICAgICd0cnVlX2NvbG9yJzogdHJ1ZSwgICAgICAgICAgICAgICAgICAgICAvLyBSZXF1ZXN0IHRydWUgY29sb3IgcGl4ZWwgZGF0YVxuICAgICAgICAnbG9jYWxfY3Vyc29yJzogZmFsc2UsICAgICAgICAgICAgICAgICAgLy8gUmVxdWVzdCBsb2NhbGx5IHJlbmRlcmVkIGN1cnNvclxuICAgICAgICAnc2hhcmVkJzogdHJ1ZSwgICAgICAgICAgICAgICAgICAgICAgICAgLy8gUmVxdWVzdCBzaGFyZWQgbW9kZVxuICAgICAgICAndmlld19vbmx5JzogZmFsc2UsICAgICAgICAgICAgICAgICAgICAgLy8gRGlzYWJsZSBjbGllbnQgbW91c2Uva2V5Ym9hcmRcbiAgICAgICAgJ3h2cF9wYXNzd29yZF9zZXAnOiAnQCcsICAgICAgICAgICAgICAgIC8vIFNlcGFyYXRvciBmb3IgWFZQIHBhc3N3b3JkIGZpZWxkc1xuICAgICAgICAnZGlzY29ubmVjdFRpbWVvdXQnOiAzLCAgICAgICAgICAgICAgICAgLy8gVGltZSAocykgdG8gd2FpdCBmb3IgZGlzY29ubmVjdGlvblxuICAgICAgICAnd3NQcm90b2NvbHMnOiBbJ2JpbmFyeSddLCAgICAgICAgICAgICAgLy8gUHJvdG9jb2xzIHRvIHVzZSBpbiB0aGUgV2ViU29ja2V0IGNvbm5lY3Rpb25cbiAgICAgICAgJ3JlcGVhdGVySUQnOiAnJywgICAgICAgICAgICAgICAgICAgICAgIC8vIFtVbHRyYVZOQ10gUmVwZWF0ZXJJRCB0byBjb25uZWN0IHRvXG4gICAgICAgICd2aWV3cG9ydERyYWcnOiBmYWxzZSwgICAgICAgICAgICAgICAgICAvLyBNb3ZlIHRoZSB2aWV3cG9ydCBvbiBtb3VzZSBkcmFnc1xuXG4gICAgICAgIC8vIENhbGxiYWNrIGZ1bmN0aW9uc1xuICAgICAgICAnb25VcGRhdGVTdGF0ZSc6IGZ1bmN0aW9uICgpIHsgfSwgICAgICAgLy8gb25VcGRhdGVTdGF0ZShyZmIsIHN0YXRlLCBvbGRzdGF0ZSwgc3RhdHVzTXNnKTogc3RhdGUgdXBkYXRlL2NoYW5nZVxuICAgICAgICAnb25QYXNzd29yZFJlcXVpcmVkJzogZnVuY3Rpb24gKCkgeyB9LCAgLy8gb25QYXNzd29yZFJlcXVpcmVkKHJmYik6IFZOQyBwYXNzd29yZCBpcyByZXF1aXJlZFxuICAgICAgICAnb25DbGlwYm9hcmQnOiBmdW5jdGlvbiAoKSB7IH0sICAgICAgICAgLy8gb25DbGlwYm9hcmQocmZiLCB0ZXh0KTogUkZCIGNsaXBib2FyZCBjb250ZW50cyByZWNlaXZlZFxuICAgICAgICAnb25CZWxsJzogZnVuY3Rpb24gKCkgeyB9LCAgICAgICAgICAgICAgLy8gb25CZWxsKHJmYik6IFJGQiBCZWxsIG1lc3NhZ2UgcmVjZWl2ZWRcbiAgICAgICAgJ29uRkJVUmVjZWl2ZSc6IGZ1bmN0aW9uICgpIHsgfSwgICAgICAgIC8vIG9uRkJVUmVjZWl2ZShyZmIsIGZidSk6IFJGQiBGQlUgcmVjZWl2ZWQgYnV0IG5vdCB5ZXQgcHJvY2Vzc2VkXG4gICAgICAgICdvbkZCVUNvbXBsZXRlJzogZnVuY3Rpb24gKCkgeyB9LCAgICAgICAvLyBvbkZCVUNvbXBsZXRlKHJmYiwgZmJ1KTogUkZCIEZCVSByZWNlaXZlZCBhbmQgcHJvY2Vzc2VkXG4gICAgICAgICdvbkZCUmVzaXplJzogZnVuY3Rpb24gKCkgeyB9LCAgICAgICAgICAvLyBvbkZCUmVzaXplKHJmYiwgd2lkdGgsIGhlaWdodCk6IGZyYW1lIGJ1ZmZlciByZXNpemVkXG4gICAgICAgICdvbkRlc2t0b3BOYW1lJzogZnVuY3Rpb24gKCkgeyB9LCAgICAgICAvLyBvbkRlc2t0b3BOYW1lKHJmYiwgbmFtZSk6IGRlc2t0b3AgbmFtZSByZWNlaXZlZFxuICAgICAgICAnb25YdnBJbml0JzogZnVuY3Rpb24gKCkgeyB9ICAgICAgICAgICAgLy8gb25YdnBJbml0KHZlcnNpb24pOiBYVlAgZXh0ZW5zaW9ucyBhY3RpdmUgZm9yIHRoaXMgY29ubmVjdGlvblxuICAgIH0pO1xuXG4gICAgLy8gbWFpbiBzZXR1cFxuICAgIFV0aWwuRGVidWcoXCI+PiBSRkIuY29uc3RydWN0b3JcIik7XG5cbiAgICAvLyBwb3B1bGF0ZSBlbmNIYW5kbGVycyB3aXRoIGJvdW5kIHZlcnNpb25zXG4gICAgT2JqZWN0LmtleXMoUkZCLmVuY29kaW5nSGFuZGxlcnMpLmZvckVhY2goZnVuY3Rpb24gKGVuY05hbWUpIHtcbiAgICAgICAgdGhpcy5fZW5jSGFuZGxlcnNbZW5jTmFtZV0gPSBSRkIuZW5jb2RpbmdIYW5kbGVyc1tlbmNOYW1lXS5iaW5kKHRoaXMpO1xuICAgIH0uYmluZCh0aGlzKSk7XG5cbiAgICAvLyBDcmVhdGUgbG9va3VwIHRhYmxlcyBiYXNlZCBvbiBlbmNvZGluZyBudW1iZXJcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMuX2VuY29kaW5ncy5sZW5ndGg7IGkrKykge1xuICAgICAgICB0aGlzLl9lbmNIYW5kbGVyc1t0aGlzLl9lbmNvZGluZ3NbaV1bMV1dID0gdGhpcy5fZW5jSGFuZGxlcnNbdGhpcy5fZW5jb2RpbmdzW2ldWzBdXTtcbiAgICAgICAgdGhpcy5fZW5jTmFtZXNbdGhpcy5fZW5jb2RpbmdzW2ldWzFdXSA9IHRoaXMuX2VuY29kaW5nc1tpXVswXTtcbiAgICAgICAgdGhpcy5fZW5jU3RhdHNbdGhpcy5fZW5jb2RpbmdzW2ldWzFdXSA9IFswLCAwXTtcbiAgICB9XG5cbiAgICAvLyBOQjogbm90aGluZyB0aGF0IG5lZWRzIGV4cGxpY2l0IHRlYXJkb3duIHNob3VsZCBiZSBkb25lXG4gICAgLy8gYmVmb3JlIHRoaXMgcG9pbnQsIHNpbmNlIHRoaXMgY2FuIHRocm93IGFuIGV4Y2VwdGlvblxuICAgIHRyeSB7XG4gICAgICAgIHRoaXMuX2Rpc3BsYXkgPSBuZXcgRGlzcGxheSh7dGFyZ2V0OiB0aGlzLl90YXJnZXR9KTtcbiAgICB9IGNhdGNoIChleGMpIHtcbiAgICAgICAgVXRpbC5FcnJvcihcIkRpc3BsYXkgZXhjZXB0aW9uOiBcIiArIGV4Yyk7XG4gICAgICAgIHRocm93IGV4YztcbiAgICB9XG5cbiAgICB0aGlzLl9rZXlib2FyZCA9IG5ldyBLZXlib2FyZCh7dGFyZ2V0OiB0aGlzLl9mb2N1c0NvbnRhaW5lcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb25LZXlQcmVzczogdGhpcy5faGFuZGxlS2V5UHJlc3MuYmluZCh0aGlzKX0pO1xuXG4gICAgdGhpcy5fbW91c2UgPSBuZXcgTW91c2Uoe3RhcmdldDogdGhpcy5fdGFyZ2V0LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbk1vdXNlQnV0dG9uOiB0aGlzLl9oYW5kbGVNb3VzZUJ1dHRvbi5iaW5kKHRoaXMpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbk1vdXNlTW92ZTogdGhpcy5faGFuZGxlTW91c2VNb3ZlLmJpbmQodGhpcyksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vdGlmeTogdGhpcy5fa2V5Ym9hcmQuc3luYy5iaW5kKHRoaXMuX2tleWJvYXJkKX0pO1xuXG4gICAgdGhpcy5fc29jayA9IG5ldyBXZWJzb2NrKCk7XG4gICAgdGhpcy5fc29jay5vbignbWVzc2FnZScsIHRoaXMuX2hhbmRsZV9tZXNzYWdlLmJpbmQodGhpcykpO1xuICAgIHRoaXMuX3NvY2sub24oJ29wZW4nLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGlmICh0aGlzLl9yZmJfc3RhdGUgPT09ICdjb25uZWN0Jykge1xuICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ1Byb3RvY29sVmVyc2lvbicsIFwiU3RhcnRpbmcgVk5DIGhhbmRzaGFrZVwiKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuX2ZhaWwoXCJHb3QgdW5leHBlY3RlZCBXZWJTb2NrZXQgY29ubmVjdGlvblwiKTtcbiAgICAgICAgfVxuICAgIH0uYmluZCh0aGlzKSk7XG4gICAgdGhpcy5fc29jay5vbignY2xvc2UnLCBmdW5jdGlvbiAoZSkge1xuICAgICAgICBVdGlsLldhcm4oXCJXZWJTb2NrZXQgb24tY2xvc2UgZXZlbnRcIik7XG4gICAgICAgIHZhciBtc2cgPSBcIlwiO1xuICAgICAgICBpZiAoZS5jb2RlKSB7XG4gICAgICAgICAgICBtc2cgPSBcIiAoY29kZTogXCIgKyBlLmNvZGU7XG4gICAgICAgICAgICBpZiAoZS5yZWFzb24pIHtcbiAgICAgICAgICAgICAgICBtc2cgKz0gXCIsIHJlYXNvbjogXCIgKyBlLnJlYXNvbjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIG1zZyArPSBcIilcIjtcbiAgICAgICAgfVxuICAgICAgICBpZiAodGhpcy5fcmZiX3N0YXRlID09PSAnZGlzY29ubmVjdCcpIHtcbiAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdkaXNjb25uZWN0ZWQnLCAnVk5DIGRpc2Nvbm5lY3RlZCcgKyBtc2cpO1xuICAgICAgICB9IGVsc2UgaWYgKHRoaXMuX3JmYl9zdGF0ZSA9PT0gJ1Byb3RvY29sVmVyc2lvbicpIHtcbiAgICAgICAgICAgIHRoaXMuX2ZhaWwoJ0ZhaWxlZCB0byBjb25uZWN0IHRvIHNlcnZlcicgKyBtc2cpO1xuICAgICAgICB9IGVsc2UgaWYgKHRoaXMuX3JmYl9zdGF0ZSBpbiB7J2ZhaWxlZCc6IDEsICdkaXNjb25uZWN0ZWQnOiAxfSkge1xuICAgICAgICAgICAgVXRpbC5FcnJvcihcIlJlY2VpdmVkIG9uY2xvc2Ugd2hpbGUgZGlzY29ubmVjdGVkXCIgKyBtc2cpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5fZmFpbChcIlNlcnZlciBkaXNjb25uZWN0ZWRcIiArIG1zZyk7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5fc29jay5vZmYoJ2Nsb3NlJyk7XG4gICAgfS5iaW5kKHRoaXMpKTtcbiAgICB0aGlzLl9zb2NrLm9uKCdlcnJvcicsIGZ1bmN0aW9uIChlKSB7XG4gICAgICAgIFV0aWwuV2FybihcIldlYlNvY2tldCBvbi1lcnJvciBldmVudFwiKTtcbiAgICB9KTtcblxuICAgIHRoaXMuX2luaXRfdmFycygpO1xuXG4gICAgdmFyIHJtb2RlID0gdGhpcy5fZGlzcGxheS5nZXRfcmVuZGVyX21vZGUoKTtcbiAgICBVdGlsLkluZm8oXCJVc2luZyBuYXRpdmUgV2ViU29ja2V0c1wiKTtcbiAgICB0aGlzLl91cGRhdGVTdGF0ZSgnbG9hZGVkJywgJ25vVk5DIHJlYWR5OiBuYXRpdmUgV2ViU29ja2V0cywgJyArIHJtb2RlKTtcblxuICAgIFV0aWwuRGVidWcoXCI8PCBSRkIuY29uc3RydWN0b3JcIik7XG59O1xuXG4oZnVuY3Rpb24oKSB7XG4gICAgUkZCLnByb3RvdHlwZSA9IHtcbiAgICAgICAgLy8gUHVibGljIG1ldGhvZHNcbiAgICAgICAgY29ubmVjdDogZnVuY3Rpb24gKGhvc3QsIHBvcnQsIHBhc3N3b3JkLCBwYXRoKSB7XG4gICAgICAgICAgICB0aGlzLl9yZmJfaG9zdCA9IGhvc3Q7XG4gICAgICAgICAgICB0aGlzLl9yZmJfcG9ydCA9IHBvcnQ7XG4gICAgICAgICAgICB0aGlzLl9yZmJfcGFzc3dvcmQgPSAocGFzc3dvcmQgIT09IHVuZGVmaW5lZCkgPyBwYXNzd29yZCA6IFwiXCI7XG4gICAgICAgICAgICB0aGlzLl9yZmJfcGF0aCA9IChwYXRoICE9PSB1bmRlZmluZWQpID8gcGF0aCA6IFwiXCI7XG5cbiAgICAgICAgICAgIGlmICghdGhpcy5fcmZiX2hvc3QgfHwgIXRoaXMuX3JmYl9wb3J0KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJNdXN0IHNldCBob3N0IGFuZCBwb3J0XCIpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgnY29ubmVjdCcpO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgZGlzY29ubmVjdDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ2Rpc2Nvbm5lY3QnLCAnRGlzY29ubmVjdGluZycpO1xuICAgICAgICAgICAgdGhpcy5fc29jay5vZmYoJ2Vycm9yJyk7XG4gICAgICAgICAgICB0aGlzLl9zb2NrLm9mZignbWVzc2FnZScpO1xuICAgICAgICAgICAgdGhpcy5fc29jay5vZmYoJ29wZW4nKTtcbiAgICAgICAgfSxcblxuICAgICAgICBzZW5kUGFzc3dvcmQ6IGZ1bmN0aW9uIChwYXNzd2QpIHtcbiAgICAgICAgICAgIHRoaXMuX3JmYl9wYXNzd29yZCA9IHBhc3N3ZDtcbiAgICAgICAgICAgIHRoaXMuX3JmYl9zdGF0ZSA9ICdBdXRoZW50aWNhdGlvbic7XG4gICAgICAgICAgICBzZXRUaW1lb3V0KHRoaXMuX2luaXRfbXNnLmJpbmQodGhpcyksIDApO1xuICAgICAgICB9LFxuXG4gICAgICAgIHNlbmRDdHJsQWx0RGVsOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fcmZiX3N0YXRlICE9PSAnbm9ybWFsJyB8fCB0aGlzLl92aWV3X29ubHkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICBVdGlsLkluZm8oXCJTZW5kaW5nIEN0cmwtQWx0LURlbFwiKTtcblxuICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmtleUV2ZW50KHRoaXMuX3NvY2ssIEtleVRhYmxlLlhLX0NvbnRyb2xfTCwgMSk7XG4gICAgICAgICAgICBSRkIubWVzc2FnZXMua2V5RXZlbnQodGhpcy5fc29jaywgS2V5VGFibGUuWEtfQWx0X0wsIDEpO1xuICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmtleUV2ZW50KHRoaXMuX3NvY2ssIEtleVRhYmxlLlhLX0RlbGV0ZSwgMSk7XG4gICAgICAgICAgICBSRkIubWVzc2FnZXMua2V5RXZlbnQodGhpcy5fc29jaywgS2V5VGFibGUuWEtfRGVsZXRlLCAwKTtcbiAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5rZXlFdmVudCh0aGlzLl9zb2NrLCBLZXlUYWJsZS5YS19BbHRfTCwgMCk7XG4gICAgICAgICAgICBSRkIubWVzc2FnZXMua2V5RXZlbnQodGhpcy5fc29jaywgS2V5VGFibGUuWEtfQ29udHJvbF9MLCAwKTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIHh2cE9wOiBmdW5jdGlvbiAodmVyLCBvcCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3JmYl94dnBfdmVyIDwgdmVyKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgVXRpbC5JbmZvKFwiU2VuZGluZyBYVlAgb3BlcmF0aW9uIFwiICsgb3AgKyBcIiAodmVyc2lvbiBcIiArIHZlciArIFwiKVwiKTtcbiAgICAgICAgICAgIHRoaXMuX3NvY2suc2VuZF9zdHJpbmcoXCJcXHhGQVxceDAwXCIgKyBTdHJpbmcuZnJvbUNoYXJDb2RlKHZlcikgKyBTdHJpbmcuZnJvbUNoYXJDb2RlKG9wKSk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICB4dnBTaHV0ZG93bjogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMueHZwT3AoMSwgMik7XG4gICAgICAgIH0sXG5cbiAgICAgICAgeHZwUmVib290OiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy54dnBPcCgxLCAzKTtcbiAgICAgICAgfSxcblxuICAgICAgICB4dnBSZXNldDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMueHZwT3AoMSwgNCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gU2VuZCBhIGtleSBwcmVzcy4gSWYgJ2Rvd24nIGlzIG5vdCBzcGVjaWZpZWQgdGhlbiBzZW5kIGEgZG93biBrZXlcbiAgICAgICAgLy8gZm9sbG93ZWQgYnkgYW4gdXAga2V5LlxuICAgICAgICBzZW5kS2V5OiBmdW5jdGlvbiAoY29kZSwgZG93bikge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3JmYl9zdGF0ZSAhPT0gXCJub3JtYWxcIiB8fCB0aGlzLl92aWV3X29ubHkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICBpZiAodHlwZW9mIGRvd24gIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiU2VuZGluZyBrZXkgY29kZSAoXCIgKyAoZG93biA/IFwiZG93blwiIDogXCJ1cFwiKSArIFwiKTogXCIgKyBjb2RlKTtcbiAgICAgICAgICAgICAgICBSRkIubWVzc2FnZXMua2V5RXZlbnQodGhpcy5fc29jaywgY29kZSwgZG93biA/IDEgOiAwKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiU2VuZGluZyBrZXkgY29kZSAoZG93biArIHVwKTogXCIgKyBjb2RlKTtcbiAgICAgICAgICAgICAgICBSRkIubWVzc2FnZXMua2V5RXZlbnQodGhpcy5fc29jaywgY29kZSwgMSk7XG4gICAgICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmtleUV2ZW50KHRoaXMuX3NvY2ssIGNvZGUsIDApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgY2xpcGJvYXJkUGFzdGVGcm9tOiBmdW5jdGlvbiAodGV4dCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3JmYl9zdGF0ZSAhPT0gJ25vcm1hbCcpIHsgcmV0dXJuOyB9XG4gICAgICAgICAgICBSRkIubWVzc2FnZXMuY2xpZW50Q3V0VGV4dCh0aGlzLl9zb2NrLCB0ZXh0KTtcbiAgICAgICAgfSxcblxuICAgICAgICAvLyBSZXF1ZXN0cyBhIGNoYW5nZSBvZiByZW1vdGUgZGVza3RvcCBzaXplLiBUaGlzIG1lc3NhZ2UgaXMgYW4gZXh0ZW5zaW9uXG4gICAgICAgIC8vIGFuZCBtYXkgb25seSBiZSBzZW50IGlmIHdlIGhhdmUgcmVjZWl2ZWQgYW4gRXh0ZW5kZWREZXNrdG9wU2l6ZSBtZXNzYWdlXG4gICAgICAgIHJlcXVlc3REZXNrdG9wU2l6ZTogZnVuY3Rpb24gKHdpZHRoLCBoZWlnaHQpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9yZmJfc3RhdGUgIT09IFwibm9ybWFsXCIpIHsgcmV0dXJuOyB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9zdXBwb3J0c1NldERlc2t0b3BTaXplKSB7XG4gICAgICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLnNldERlc2t0b3BTaXplKHRoaXMuX3NvY2ssIHdpZHRoLCBoZWlnaHQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3NjcmVlbl9pZCwgdGhpcy5fc2NyZWVuX2ZsYWdzKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLmZsdXNoKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cblxuICAgICAgICAvLyBQcml2YXRlIG1ldGhvZHNcblxuICAgICAgICBfY29ubmVjdDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIj4+IFJGQi5jb25uZWN0XCIpO1xuXG4gICAgICAgICAgICB2YXIgdXJpO1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBVc2luZ1NvY2tldElPICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgICAgICAgIHVyaSA9ICdodHRwJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdXJpID0gdGhpcy5fZW5jcnlwdCA/ICd3c3MnIDogJ3dzJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdXJpICs9ICc6Ly8nICsgdGhpcy5fcmZiX2hvc3QgKyAnOicgKyB0aGlzLl9yZmJfcG9ydCArICcvJyArIHRoaXMuX3JmYl9wYXRoO1xuICAgICAgICAgICAgVXRpbC5JbmZvKFwiY29ubmVjdGluZyB0byBcIiArIHVyaSk7XG5cbiAgICAgICAgICAgIHRoaXMuX3NvY2sub3Blbih1cmksIHRoaXMuX3dzUHJvdG9jb2xzKTtcblxuICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIjw8IFJGQi5jb25uZWN0XCIpO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9pbml0X3ZhcnM6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIC8vIHJlc2V0IHN0YXRlXG4gICAgICAgICAgICB0aGlzLl9GQlUucmVjdHMgICAgICAgID0gMDtcbiAgICAgICAgICAgIHRoaXMuX0ZCVS5zdWJyZWN0cyAgICAgPSAwOyAgLy8gUlJFIGFuZCBIRVhUSUxFXG4gICAgICAgICAgICB0aGlzLl9GQlUubGluZXMgICAgICAgID0gMDsgIC8vIFJBV1xuICAgICAgICAgICAgdGhpcy5fRkJVLnRpbGVzICAgICAgICA9IDA7ICAvLyBIRVhUSUxFXG4gICAgICAgICAgICB0aGlzLl9GQlUuemxpYnMgICAgICAgID0gW107IC8vIFRJR0hUIHpsaWIgZW5jb2RlcnNcbiAgICAgICAgICAgIHRoaXMuX21vdXNlX2J1dHRvbk1hc2sgPSAwO1xuICAgICAgICAgICAgdGhpcy5fbW91c2VfYXJyICAgICAgICA9IFtdO1xuICAgICAgICAgICAgdGhpcy5fcmZiX3RpZ2h0dm5jICAgICA9IGZhbHNlO1xuXG4gICAgICAgICAgICAvLyBDbGVhciB0aGUgcGVyIGNvbm5lY3Rpb24gZW5jb2Rpbmcgc3RhdHNcbiAgICAgICAgICAgIHZhciBpO1xuICAgICAgICAgICAgZm9yIChpID0gMDsgaSA8IHRoaXMuX2VuY29kaW5ncy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgICAgIHRoaXMuX2VuY1N0YXRzW3RoaXMuX2VuY29kaW5nc1tpXVsxXV1bMF0gPSAwO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmb3IgKGkgPSAwOyBpIDwgNDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLnpsaWJzW2ldID0gbmV3IEluZmxhdG9yLkluZmxhdGUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBfcHJpbnRfc3RhdHM6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIFV0aWwuSW5mbyhcIkVuY29kaW5nIHN0YXRzIGZvciB0aGlzIGNvbm5lY3Rpb246XCIpO1xuICAgICAgICAgICAgdmFyIGksIHM7XG4gICAgICAgICAgICBmb3IgKGkgPSAwOyBpIDwgdGhpcy5fZW5jb2RpbmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgcyA9IHRoaXMuX2VuY1N0YXRzW3RoaXMuX2VuY29kaW5nc1tpXVsxXV07XG4gICAgICAgICAgICAgICAgaWYgKHNbMF0gKyBzWzFdID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBVdGlsLkluZm8oXCIgICAgXCIgKyB0aGlzLl9lbmNvZGluZ3NbaV1bMF0gKyBcIjogXCIgKyBzWzBdICsgXCIgcmVjdHNcIik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBVdGlsLkluZm8oXCJFbmNvZGluZyBzdGF0cyBzaW5jZSBwYWdlIGxvYWQ6XCIpO1xuICAgICAgICAgICAgZm9yIChpID0gMDsgaSA8IHRoaXMuX2VuY29kaW5ncy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgICAgIHMgPSB0aGlzLl9lbmNTdGF0c1t0aGlzLl9lbmNvZGluZ3NbaV1bMV1dO1xuICAgICAgICAgICAgICAgIFV0aWwuSW5mbyhcIiAgICBcIiArIHRoaXMuX2VuY29kaW5nc1tpXVswXSArIFwiOiBcIiArIHNbMV0gKyBcIiByZWN0c1wiKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBfY2xlYW51cFNvY2tldDogZnVuY3Rpb24gKHN0YXRlKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fbXNnVGltZXIpIHtcbiAgICAgICAgICAgICAgICBjbGVhckludGVydmFsKHRoaXMuX21zZ1RpbWVyKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9tc2dUaW1lciA9IG51bGw7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9kaXNwbGF5ICYmIHRoaXMuX2Rpc3BsYXkuZ2V0X2NvbnRleHQoKSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX2tleWJvYXJkLnVuZ3JhYigpO1xuICAgICAgICAgICAgICAgIHRoaXMuX21vdXNlLnVuZ3JhYigpO1xuICAgICAgICAgICAgICAgIGlmIChzdGF0ZSAhPT0gJ2Nvbm5lY3QnICYmIHN0YXRlICE9PSAnbG9hZGVkJykge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmRlZmF1bHRDdXJzb3IoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKFV0aWwuZ2V0X2xvZ2dpbmcoKSAhPT0gJ2RlYnVnJyB8fCBzdGF0ZSA9PT0gJ2xvYWRlZCcpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gU2hvdyBub1ZOQyBsb2dvIG9uIGxvYWQgYW5kIHdoZW4gZGlzY29ubmVjdGVkLCB1bmxlc3MgaW5cbiAgICAgICAgICAgICAgICAgICAgLy8gZGVidWcgbW9kZVxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmNsZWFyKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aGlzLl9zb2NrLmNsb3NlKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgLypcbiAgICAgICAgICogUGFnZSBzdGF0ZXM6XG4gICAgICAgICAqICAgbG9hZGVkICAgICAgIC0gcGFnZSBsb2FkLCBlcXVpdmFsZW50IHRvIGRpc2Nvbm5lY3RlZFxuICAgICAgICAgKiAgIGRpc2Nvbm5lY3RlZCAtIGlkbGUgc3RhdGVcbiAgICAgICAgICogICBjb25uZWN0ICAgICAgLSBzdGFydGluZyB0byBjb25uZWN0ICh0byBQcm90b2NvbFZlcnNpb24pXG4gICAgICAgICAqICAgbm9ybWFsICAgICAgIC0gY29ubmVjdGVkXG4gICAgICAgICAqICAgZGlzY29ubmVjdCAgIC0gc3RhcnRpbmcgdG8gZGlzY29ubmVjdFxuICAgICAgICAgKiAgIGZhaWxlZCAgICAgICAtIGFibm9ybWFsIGRpc2Nvbm5lY3RcbiAgICAgICAgICogICBmYXRhbCAgICAgICAgLSBmYWlsZWQgdG8gbG9hZCBwYWdlLCBvciBmYXRhbCBlcnJvclxuICAgICAgICAgKlxuICAgICAgICAgKiBSRkIgcHJvdG9jb2wgaW5pdGlhbGl6YXRpb24gc3RhdGVzOlxuICAgICAgICAgKiAgIFByb3RvY29sVmVyc2lvblxuICAgICAgICAgKiAgIFNlY3VyaXR5XG4gICAgICAgICAqICAgQXV0aGVudGljYXRpb25cbiAgICAgICAgICogICBwYXNzd29yZCAgICAgLSB3YWl0aW5nIGZvciBwYXNzd29yZCwgbm90IHBhcnQgb2YgUkZCXG4gICAgICAgICAqICAgU2VjdXJpdHlSZXN1bHRcbiAgICAgICAgICogICBDbGllbnRJbml0aWFsaXphdGlvbiAtIG5vdCB0cmlnZ2VyZWQgYnkgc2VydmVyIG1lc3NhZ2VcbiAgICAgICAgICogICBTZXJ2ZXJJbml0aWFsaXphdGlvbiAodG8gbm9ybWFsKVxuICAgICAgICAgKi9cbiAgICAgICAgX3VwZGF0ZVN0YXRlOiBmdW5jdGlvbiAoc3RhdGUsIHN0YXR1c01zZykge1xuICAgICAgICAgICAgdmFyIG9sZHN0YXRlID0gdGhpcy5fcmZiX3N0YXRlO1xuXG4gICAgICAgICAgICBpZiAoc3RhdGUgPT09IG9sZHN0YXRlKSB7XG4gICAgICAgICAgICAgICAgLy8gQWxyZWFkeSBoZXJlLCBpZ25vcmVcbiAgICAgICAgICAgICAgICBVdGlsLkRlYnVnKFwiQWxyZWFkeSBpbiBzdGF0ZSAnXCIgKyBzdGF0ZSArIFwiJywgaWdub3JpbmdcIik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qXG4gICAgICAgICAgICAgKiBUaGVzZSBhcmUgZGlzY29ubmVjdGVkIHN0YXRlcy4gQSBwcmV2aW91cyBjb25uZWN0IG1heVxuICAgICAgICAgICAgICogYXN5bmNocm9ub3VzbHkgY2F1c2UgYSBjb25uZWN0aW9uIHNvIG1ha2Ugc3VyZSB3ZSBhcmUgY2xvc2VkLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBpZiAoc3RhdGUgaW4geydkaXNjb25uZWN0ZWQnOiAxLCAnbG9hZGVkJzogMSwgJ2Nvbm5lY3QnOiAxLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAnZGlzY29ubmVjdCc6IDEsICdmYWlsZWQnOiAxLCAnZmF0YWwnOiAxfSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX2NsZWFudXBTb2NrZXQoc3RhdGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAob2xkc3RhdGUgPT09ICdmYXRhbCcpIHtcbiAgICAgICAgICAgICAgICBVdGlsLkVycm9yKCdGYXRhbCBlcnJvciwgY2Fubm90IGNvbnRpbnVlJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHZhciBjbXNnID0gdHlwZW9mKHN0YXR1c01zZykgIT09ICd1bmRlZmluZWQnID8gKFwiIE1zZzogXCIgKyBzdGF0dXNNc2cpIDogXCJcIjtcbiAgICAgICAgICAgIHZhciBmdWxsbXNnID0gXCJOZXcgc3RhdGUgJ1wiICsgc3RhdGUgKyBcIicsIHdhcyAnXCIgKyBvbGRzdGF0ZSArIFwiJy5cIiArIGNtc2c7XG4gICAgICAgICAgICBpZiAoc3RhdGUgPT09ICdmYWlsZWQnIHx8IHN0YXRlID09PSAnZmF0YWwnKSB7XG4gICAgICAgICAgICAgICAgVXRpbC5FcnJvcihjbXNnKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgVXRpbC5XYXJuKGNtc2cpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAob2xkc3RhdGUgPT09ICdmYWlsZWQnICYmIHN0YXRlID09PSAnZGlzY29ubmVjdGVkJykge1xuICAgICAgICAgICAgICAgIC8vIGRvIGRpc2Nvbm5lY3QgYWN0aW9uLCBidXQgc3RheSBpbiBmYWlsZWQgc3RhdGVcbiAgICAgICAgICAgICAgICB0aGlzLl9yZmJfc3RhdGUgPSAnZmFpbGVkJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fcmZiX3N0YXRlID0gc3RhdGU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9kaXNjb25uVGltZXIgJiYgdGhpcy5fcmZiX3N0YXRlICE9PSAnZGlzY29ubmVjdCcpIHtcbiAgICAgICAgICAgICAgICBVdGlsLkRlYnVnKFwiQ2xlYXJpbmcgZGlzY29ubmVjdCB0aW1lclwiKTtcbiAgICAgICAgICAgICAgICBjbGVhclRpbWVvdXQodGhpcy5fZGlzY29ublRpbWVyKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9kaXNjb25uVGltZXIgPSBudWxsO1xuICAgICAgICAgICAgICAgIHRoaXMuX3NvY2sub2ZmKCdjbG9zZScpOyAgLy8gbWFrZSBzdXJlIHdlIGRvbid0IGdldCBhIGRvdWJsZSBldmVudFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBzd2l0Y2ggKHN0YXRlKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnbm9ybWFsJzpcbiAgICAgICAgICAgICAgICAgICAgaWYgKG9sZHN0YXRlID09PSAnZGlzY29ubmVjdGVkJyB8fCBvbGRzdGF0ZSA9PT0gJ2ZhaWxlZCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFV0aWwuRXJyb3IoXCJJbnZhbGlkIHRyYW5zaXRpb24gZnJvbSAnZGlzY29ubmVjdGVkJyBvciAnZmFpbGVkJyB0byAnbm9ybWFsJ1wiKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2Nvbm5lY3QnOlxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9pbml0X3ZhcnMoKTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fY29ubmVjdCgpO1xuICAgICAgICAgICAgICAgICAgICAvLyBXZWJTb2NrZXQub25vcGVuIHRyYW5zaXRpb25zIHRvICdQcm90b2NvbFZlcnNpb24nXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnZGlzY29ubmVjdCc6XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2Rpc2Nvbm5UaW1lciA9IHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmFpbChcIkRpc2Nvbm5lY3QgdGltZW91dFwiKTtcbiAgICAgICAgICAgICAgICAgICAgfS5iaW5kKHRoaXMpLCB0aGlzLl9kaXNjb25uZWN0VGltZW91dCAqIDEwMDApO1xuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3ByaW50X3N0YXRzKCk7XG5cbiAgICAgICAgICAgICAgICAgICAgLy8gV2ViU29ja2V0Lm9uY2xvc2UgdHJhbnNpdGlvbnMgdG8gJ2Rpc2Nvbm5lY3RlZCdcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdmYWlsZWQnOlxuICAgICAgICAgICAgICAgICAgICBpZiAob2xkc3RhdGUgPT09ICdkaXNjb25uZWN0ZWQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBVdGlsLkVycm9yKFwiSW52YWxpZCB0cmFuc2l0aW9uIGZyb20gJ2Rpc2Nvbm5lY3RlZCcgdG8gJ2ZhaWxlZCdcIik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAob2xkc3RhdGUgPT09ICdub3JtYWwnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBVdGlsLkVycm9yKFwiRXJyb3Igd2hpbGUgY29ubmVjdGVkLlwiKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChvbGRzdGF0ZSA9PT0gJ2luaXQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBVdGlsLkVycm9yKFwiRXJyb3Igd2hpbGUgaW5pdGlhbGl6aW5nLlwiKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vIE1ha2Ugc3VyZSB3ZSB0cmFuc2l0aW9uIHRvIGRpc2Nvbm5lY3RlZFxuICAgICAgICAgICAgICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdkaXNjb25uZWN0ZWQnKTtcbiAgICAgICAgICAgICAgICAgICAgfS5iaW5kKHRoaXMpLCA1MCk7XG5cbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICAvLyBObyBzdGF0ZSBjaGFuZ2UgYWN0aW9uIHRvIHRha2VcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG9sZHN0YXRlID09PSAnZmFpbGVkJyAmJiBzdGF0ZSA9PT0gJ2Rpc2Nvbm5lY3RlZCcpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9vblVwZGF0ZVN0YXRlKHRoaXMsIHN0YXRlLCBvbGRzdGF0ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX29uVXBkYXRlU3RhdGUodGhpcywgc3RhdGUsIG9sZHN0YXRlLCBzdGF0dXNNc2cpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIF9mYWlsOiBmdW5jdGlvbiAobXNnKSB7XG4gICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgnZmFpbGVkJywgbXNnKTtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfSxcblxuICAgICAgICBfaGFuZGxlX21lc3NhZ2U6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRbGVuKCkgPT09IDApIHtcbiAgICAgICAgICAgICAgICBVdGlsLldhcm4oXCJoYW5kbGVfbWVzc2FnZSBjYWxsZWQgb24gYW4gZW1wdHkgcmVjZWl2ZSBxdWV1ZVwiKTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHN3aXRjaCAodGhpcy5fcmZiX3N0YXRlKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnZGlzY29ubmVjdGVkJzpcbiAgICAgICAgICAgICAgICBjYXNlICdmYWlsZWQnOlxuICAgICAgICAgICAgICAgICAgICBVdGlsLkVycm9yKFwiR290IGRhdGEgd2hpbGUgZGlzY29ubmVjdGVkXCIpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlICdub3JtYWwnOlxuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fbm9ybWFsX21zZygpICYmIHRoaXMuX3NvY2suclFsZW4oKSA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIHRydWUgbWVhbnMgd2UgY2FuIGNvbnRpbnVlIHByb2Nlc3NpbmdcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIEdpdmUgb3RoZXIgZXZlbnRzIGEgY2hhbmNlIHRvIHJ1blxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX21zZ1RpbWVyID09PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIk1vcmUgZGF0YSB0byBwcm9jZXNzLCBjcmVhdGluZyB0aW1lclwiKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9tc2dUaW1lciA9IHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9tc2dUaW1lciA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2hhbmRsZV9tZXNzYWdlKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfS5iaW5kKHRoaXMpLCAwKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIk1vcmUgZGF0YSB0byBwcm9jZXNzLCBleGlzdGluZyB0aW1lclwiKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9pbml0X21zZygpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBfaGFuZGxlS2V5UHJlc3M6IGZ1bmN0aW9uIChrZXlldmVudCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3ZpZXdfb25seSkgeyByZXR1cm47IH0gLy8gVmlldyBvbmx5LCBza2lwIGtleWJvYXJkLCBldmVudHNcblxuICAgICAgICAgICAgdmFyIGRvd24gPSAoa2V5ZXZlbnQudHlwZSA9PSAna2V5ZG93bicpO1xuICAgICAgICAgICAgaWYgKHRoaXMuX3FlbXVFeHRLZXlFdmVudFN1cHBvcnRlZCkge1xuICAgICAgICAgICAgICAgIHZhciBzY2FuY29kZSA9IFh0U2NhbmNvZGVba2V5ZXZlbnQuY29kZV07XG4gICAgICAgICAgICAgICAgaWYgKHNjYW5jb2RlKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBrZXlzeW0gPSBrZXlldmVudC5rZXlzeW07XG4gICAgICAgICAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5RRU1VRXh0ZW5kZWRLZXlFdmVudCh0aGlzLl9zb2NrLCBrZXlzeW0sIGRvd24sIHNjYW5jb2RlKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBVdGlsLkVycm9yKCdVbmFibGUgdG8gZmluZCBhIHh0IHNjYW5jb2RlIGZvciBjb2RlID0gJyArIGtleWV2ZW50LmNvZGUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAga2V5c3ltID0ga2V5ZXZlbnQua2V5c3ltLmtleXN5bTtcbiAgICAgICAgICAgICAgICBSRkIubWVzc2FnZXMua2V5RXZlbnQodGhpcy5fc29jaywga2V5c3ltLCBkb3duKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBfaGFuZGxlTW91c2VCdXR0b246IGZ1bmN0aW9uICh4LCB5LCBkb3duLCBibWFzaykge1xuICAgICAgICAgICAgaWYgKGRvd24pIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9tb3VzZV9idXR0b25NYXNrIHw9IGJtYXNrO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9tb3VzZV9idXR0b25NYXNrIF49IGJtYXNrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5fdmlld3BvcnREcmFnKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRvd24gJiYgIXRoaXMuX3ZpZXdwb3J0RHJhZ2dpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdmlld3BvcnREcmFnZ2luZyA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3ZpZXdwb3J0RHJhZ1BvcyA9IHsneCc6IHgsICd5JzogeX07XG5cbiAgICAgICAgICAgICAgICAgICAgLy8gU2tpcCBzZW5kaW5nIG1vdXNlIGV2ZW50c1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdmlld3BvcnREcmFnZ2luZyA9IGZhbHNlO1xuXG4gICAgICAgICAgICAgICAgICAgIC8vIElmIHRoZSB2aWV3cG9ydCBkaWRuJ3QgYWN0dWFsbHkgbW92ZSwgdGhlbiB0cmVhdCBhcyBhIG1vdXNlIGNsaWNrIGV2ZW50XG4gICAgICAgICAgICAgICAgICAgIC8vIFNlbmQgdGhlIGJ1dHRvbiBkb3duIGV2ZW50IGhlcmUsIGFzIHRoZSBidXR0b24gdXAgZXZlbnQgaXMgc2VudCBhdCB0aGUgZW5kIG9mIHRoaXMgZnVuY3Rpb25cbiAgICAgICAgICAgICAgICAgICAgaWYgKCF0aGlzLl92aWV3cG9ydEhhc01vdmVkICYmICF0aGlzLl92aWV3X29ubHkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5wb2ludGVyRXZlbnQodGhpcy5fc29jaywgdGhpcy5fZGlzcGxheS5hYnNYKHgpLCB0aGlzLl9kaXNwbGF5LmFic1koeSksIGJtYXNrKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB0aGlzLl92aWV3cG9ydEhhc01vdmVkID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5fdmlld19vbmx5KSB7IHJldHVybjsgfSAvLyBWaWV3IG9ubHksIHNraXAgbW91c2UgZXZlbnRzXG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9yZmJfc3RhdGUgIT09IFwibm9ybWFsXCIpIHsgcmV0dXJuOyB9XG4gICAgICAgICAgICBSRkIubWVzc2FnZXMucG9pbnRlckV2ZW50KHRoaXMuX3NvY2ssIHRoaXMuX2Rpc3BsYXkuYWJzWCh4KSwgdGhpcy5fZGlzcGxheS5hYnNZKHkpLCB0aGlzLl9tb3VzZV9idXR0b25NYXNrKTtcbiAgICAgICAgfSxcblxuICAgICAgICBfaGFuZGxlTW91c2VNb3ZlOiBmdW5jdGlvbiAoeCwgeSkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3ZpZXdwb3J0RHJhZ2dpbmcpIHtcbiAgICAgICAgICAgICAgICB2YXIgZGVsdGFYID0gdGhpcy5fdmlld3BvcnREcmFnUG9zLnggLSB4O1xuICAgICAgICAgICAgICAgIHZhciBkZWx0YVkgPSB0aGlzLl92aWV3cG9ydERyYWdQb3MueSAtIHk7XG5cbiAgICAgICAgICAgICAgICAvLyBUaGUgZ29hbCBpcyB0byB0cmlnZ2VyIG9uIGEgY2VydGFpbiBwaHlzaWNhbCB3aWR0aCwgdGhlXG4gICAgICAgICAgICAgICAgLy8gZGV2aWNlUGl4ZWxSYXRpbyBicmluZ3MgdXMgYSBiaXQgY2xvc2VyIGJ1dCBpcyBub3Qgb3B0aW1hbC5cbiAgICAgICAgICAgICAgICB2YXIgZHJhZ1RocmVzaG9sZCA9IDEwICogKHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvIHx8IDEpO1xuXG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3ZpZXdwb3J0SGFzTW92ZWQgfHwgKE1hdGguYWJzKGRlbHRhWCkgPiBkcmFnVGhyZXNob2xkIHx8XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIE1hdGguYWJzKGRlbHRhWSkgPiBkcmFnVGhyZXNob2xkKSkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl92aWV3cG9ydEhhc01vdmVkID0gdHJ1ZTtcblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl92aWV3cG9ydERyYWdQb3MgPSB7J3gnOiB4LCAneSc6IHl9O1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LnZpZXdwb3J0Q2hhbmdlUG9zKGRlbHRhWCwgZGVsdGFZKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvLyBTa2lwIHNlbmRpbmcgbW91c2UgZXZlbnRzXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5fdmlld19vbmx5KSB7IHJldHVybjsgfSAvLyBWaWV3IG9ubHksIHNraXAgbW91c2UgZXZlbnRzXG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9yZmJfc3RhdGUgIT09IFwibm9ybWFsXCIpIHsgcmV0dXJuOyB9XG4gICAgICAgICAgICBSRkIubWVzc2FnZXMucG9pbnRlckV2ZW50KHRoaXMuX3NvY2ssIHRoaXMuX2Rpc3BsYXkuYWJzWCh4KSwgdGhpcy5fZGlzcGxheS5hYnNZKHkpLCB0aGlzLl9tb3VzZV9idXR0b25NYXNrKTtcbiAgICAgICAgfSxcblxuICAgICAgICAvLyBNZXNzYWdlIEhhbmRsZXJzXG5cbiAgICAgICAgX25lZ290aWF0ZV9wcm90b2NvbF92ZXJzaW9uOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUWxlbigpIDwgMTIpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChcIkluY29tcGxldGUgcHJvdG9jb2wgdmVyc2lvblwiKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFyIHN2ZXJzaW9uID0gdGhpcy5fc29jay5yUXNoaWZ0U3RyKDEyKS5zdWJzdHIoNCwgNyk7XG4gICAgICAgICAgICBVdGlsLkluZm8oXCJTZXJ2ZXIgUHJvdG9jb2xWZXJzaW9uOiBcIiArIHN2ZXJzaW9uKTtcbiAgICAgICAgICAgIHZhciBpc19yZXBlYXRlciA9IDA7XG4gICAgICAgICAgICBzd2l0Y2ggKHN2ZXJzaW9uKSB7XG4gICAgICAgICAgICAgICAgY2FzZSBcIjAwMC4wMDBcIjogIC8vIFVsdHJhVk5DIHJlcGVhdGVyXG4gICAgICAgICAgICAgICAgICAgIGlzX3JlcGVhdGVyID0gMTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSBcIjAwMy4wMDNcIjpcbiAgICAgICAgICAgICAgICBjYXNlIFwiMDAzLjAwNlwiOiAgLy8gVWx0cmFWTkNcbiAgICAgICAgICAgICAgICBjYXNlIFwiMDAzLjg4OVwiOiAgLy8gQXBwbGUgUmVtb3RlIERlc2t0b3BcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcmZiX3ZlcnNpb24gPSAzLjM7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgXCIwMDMuMDA3XCI6XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3JmYl92ZXJzaW9uID0gMy43O1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIFwiMDAzLjAwOFwiOlxuICAgICAgICAgICAgICAgIGNhc2UgXCIwMDQuMDAwXCI6ICAvLyBJbnRlbCBBTVQgS1ZNXG4gICAgICAgICAgICAgICAgY2FzZSBcIjAwNC4wMDFcIjogIC8vIFJlYWxWTkMgNC42XG4gICAgICAgICAgICAgICAgY2FzZSBcIjAwNS4wMDBcIjogIC8vIFJlYWxWTkMgNS4zXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3JmYl92ZXJzaW9uID0gMy44O1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChcIkludmFsaWQgc2VydmVyIHZlcnNpb24gXCIgKyBzdmVyc2lvbik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChpc19yZXBlYXRlcikge1xuICAgICAgICAgICAgICAgIHZhciByZXBlYXRlcklEID0gdGhpcy5fcmVwZWF0ZXJJRDtcbiAgICAgICAgICAgICAgICB3aGlsZSAocmVwZWF0ZXJJRC5sZW5ndGggPCAyNTApIHtcbiAgICAgICAgICAgICAgICAgICAgcmVwZWF0ZXJJRCArPSBcIlxcMFwiO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnNlbmRfc3RyaW5nKHJlcGVhdGVySUQpO1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5fcmZiX3ZlcnNpb24gPiB0aGlzLl9yZmJfbWF4X3ZlcnNpb24pIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9yZmJfdmVyc2lvbiA9IHRoaXMuX3JmYl9tYXhfdmVyc2lvbjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFyIGN2ZXJzaW9uID0gXCIwMFwiICsgcGFyc2VJbnQodGhpcy5fcmZiX3ZlcnNpb24sIDEwKSArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICBcIi4wMFwiICsgKCh0aGlzLl9yZmJfdmVyc2lvbiAqIDEwKSAlIDEwKTtcbiAgICAgICAgICAgIHRoaXMuX3NvY2suc2VuZF9zdHJpbmcoXCJSRkIgXCIgKyBjdmVyc2lvbiArIFwiXFxuXCIpO1xuICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ1NlY3VyaXR5JywgJ1NlbnQgUHJvdG9jb2xWZXJzaW9uOiAnICsgY3ZlcnNpb24pO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9uZWdvdGlhdGVfc2VjdXJpdHk6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9yZmJfdmVyc2lvbiA+PSAzLjcpIHtcbiAgICAgICAgICAgICAgICAvLyBTZXJ2ZXIgc2VuZHMgc3VwcG9ydGVkIGxpc3QsIGNsaWVudCBkZWNpZGVzXG4gICAgICAgICAgICAgICAgdmFyIG51bV90eXBlcyA9IHRoaXMuX3NvY2suclFzaGlmdDgoKTtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJzZWN1cml0eSB0eXBlXCIsIG51bV90eXBlcywgMSkpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgICAgICBpZiAobnVtX3R5cGVzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBzdHJsZW4gPSB0aGlzLl9zb2NrLnJRc2hpZnQzMigpO1xuICAgICAgICAgICAgICAgICAgICB2YXIgcmVhc29uID0gdGhpcy5fc29jay5yUXNoaWZ0U3RyKHN0cmxlbik7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiU2VjdXJpdHkgZmFpbHVyZTogXCIgKyByZWFzb24pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHRoaXMuX3JmYl9hdXRoX3NjaGVtZSA9IDA7XG4gICAgICAgICAgICAgICAgdmFyIHR5cGVzID0gdGhpcy5fc29jay5yUXNoaWZ0Qnl0ZXMobnVtX3R5cGVzKTtcbiAgICAgICAgICAgICAgICBVdGlsLkRlYnVnKFwiU2VydmVyIHNlY3VyaXR5IHR5cGVzOiBcIiArIHR5cGVzKTtcbiAgICAgICAgICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHR5cGVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICh0eXBlc1tpXSA+IHRoaXMuX3JmYl9hdXRoX3NjaGVtZSAmJiAodHlwZXNbaV0gPD0gMTYgfHwgdHlwZXNbaV0gPT0gMjIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9yZmJfYXV0aF9zY2hlbWUgPSB0eXBlc1tpXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9yZmJfYXV0aF9zY2hlbWUgPT09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJVbnN1cHBvcnRlZCBzZWN1cml0eSB0eXBlczogXCIgKyB0eXBlcyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5zZW5kKFt0aGlzLl9yZmJfYXV0aF9zY2hlbWVdKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gU2VydmVyIGRlY2lkZXNcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJzZWN1cml0eSBzY2hlbWVcIiwgNCkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICAgICAgdGhpcy5fcmZiX2F1dGhfc2NoZW1lID0gdGhpcy5fc29jay5yUXNoaWZ0MzIoKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ0F1dGhlbnRpY2F0aW9uJywgJ0F1dGhlbnRpY2F0aW5nIHVzaW5nIHNjaGVtZTogJyArIHRoaXMuX3JmYl9hdXRoX3NjaGVtZSk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5faW5pdF9tc2coKTsgLy8ganVtcCB0byBhdXRoZW50aWNhdGlvblxuICAgICAgICB9LFxuXG4gICAgICAgIC8vIGF1dGhlbnRpY2F0aW9uXG4gICAgICAgIF9uZWdvdGlhdGVfeHZwX2F1dGg6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHZhciB4dnBfc2VwID0gdGhpcy5feHZwX3Bhc3N3b3JkX3NlcDtcbiAgICAgICAgICAgIHZhciB4dnBfYXV0aCA9IHRoaXMuX3JmYl9wYXNzd29yZC5zcGxpdCh4dnBfc2VwKTtcbiAgICAgICAgICAgIGlmICh4dnBfYXV0aC5sZW5ndGggPCAzKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ3Bhc3N3b3JkJywgJ1hWUCBjcmVkZW50aWFscyByZXF1aXJlZCAodXNlcicgKyB4dnBfc2VwICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAndGFyZ2V0JyArIHh2cF9zZXAgKyAncGFzc3dvcmQpIC0tIGdvdCBvbmx5ICcgKyB0aGlzLl9yZmJfcGFzc3dvcmQpO1xuICAgICAgICAgICAgICAgIHRoaXMuX29uUGFzc3dvcmRSZXF1aXJlZCh0aGlzKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHZhciB4dnBfYXV0aF9zdHIgPSBTdHJpbmcuZnJvbUNoYXJDb2RlKHh2cF9hdXRoWzBdLmxlbmd0aCkgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFN0cmluZy5mcm9tQ2hhckNvZGUoeHZwX2F1dGhbMV0ubGVuZ3RoKSArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeHZwX2F1dGhbMF0gK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHh2cF9hdXRoWzFdO1xuICAgICAgICAgICAgdGhpcy5fc29jay5zZW5kX3N0cmluZyh4dnBfYXV0aF9zdHIpO1xuICAgICAgICAgICAgdGhpcy5fcmZiX3Bhc3N3b3JkID0geHZwX2F1dGguc2xpY2UoMikuam9pbih4dnBfc2VwKTtcbiAgICAgICAgICAgIHRoaXMuX3JmYl9hdXRoX3NjaGVtZSA9IDI7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fbmVnb3RpYXRlX2F1dGhlbnRpY2F0aW9uKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX25lZ290aWF0ZV9zdGRfdm5jX2F1dGg6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9yZmJfcGFzc3dvcmQubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAgICAgLy8gTm90aWZ5IHZpYSBib3RoIGNhbGxiYWNrcyBzaW5jZSBpdCdzIGtpbmQgb2ZcbiAgICAgICAgICAgICAgICAvLyBhbiBSRkIgc3RhdGUgY2hhbmdlIGFuZCBhIFVJIGludGVyZmFjZSBpc3N1ZVxuICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdwYXNzd29yZCcsIFwiUGFzc3dvcmQgUmVxdWlyZWRcIik7XG4gICAgICAgICAgICAgICAgdGhpcy5fb25QYXNzd29yZFJlcXVpcmVkKHRoaXMpO1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiYXV0aCBjaGFsbGVuZ2VcIiwgMTYpKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgICAgICAgICAvLyBUT0RPKGRpcmVjdHhtYW4xMik6IG1ha2UgZ2VuREVTIG5vdCByZXF1aXJlIGFuIEFycmF5XG4gICAgICAgICAgICB2YXIgY2hhbGxlbmdlID0gQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwodGhpcy5fc29jay5yUXNoaWZ0Qnl0ZXMoMTYpKTtcbiAgICAgICAgICAgIHZhciByZXNwb25zZSA9IFJGQi5nZW5ERVModGhpcy5fcmZiX3Bhc3N3b3JkLCBjaGFsbGVuZ2UpO1xuICAgICAgICAgICAgdGhpcy5fc29jay5zZW5kKHJlc3BvbnNlKTtcbiAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKFwiU2VjdXJpdHlSZXN1bHRcIik7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBfbmVnb3RpYXRlX3RpZ2h0X3R1bm5lbHM6IGZ1bmN0aW9uIChudW1UdW5uZWxzKSB7XG4gICAgICAgICAgICB2YXIgY2xpZW50U3VwcG9ydGVkVHVubmVsVHlwZXMgPSB7XG4gICAgICAgICAgICAgICAgMDogeyB2ZW5kb3I6ICdUR0hUJywgc2lnbmF0dXJlOiAnTk9UVU5ORUwnIH1cbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICB2YXIgc2VydmVyU3VwcG9ydGVkVHVubmVsVHlwZXMgPSB7fTtcbiAgICAgICAgICAgIC8vIHJlY2VpdmUgdHVubmVsIGNhcGFiaWxpdGllc1xuICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBudW1UdW5uZWxzOyBpKyspIHtcbiAgICAgICAgICAgICAgICB2YXIgY2FwX2NvZGUgPSB0aGlzLl9zb2NrLnJRc2hpZnQzMigpO1xuICAgICAgICAgICAgICAgIHZhciBjYXBfdmVuZG9yID0gdGhpcy5fc29jay5yUXNoaWZ0U3RyKDQpO1xuICAgICAgICAgICAgICAgIHZhciBjYXBfc2lnbmF0dXJlID0gdGhpcy5fc29jay5yUXNoaWZ0U3RyKDgpO1xuICAgICAgICAgICAgICAgIHNlcnZlclN1cHBvcnRlZFR1bm5lbFR5cGVzW2NhcF9jb2RlXSA9IHsgdmVuZG9yOiBjYXBfdmVuZG9yLCBzaWduYXR1cmU6IGNhcF9zaWduYXR1cmUgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gY2hvb3NlIHRoZSBub3R1bm5lbCB0eXBlXG4gICAgICAgICAgICBpZiAoc2VydmVyU3VwcG9ydGVkVHVubmVsVHlwZXNbMF0pIHtcbiAgICAgICAgICAgICAgICBpZiAoc2VydmVyU3VwcG9ydGVkVHVubmVsVHlwZXNbMF0udmVuZG9yICE9IGNsaWVudFN1cHBvcnRlZFR1bm5lbFR5cGVzWzBdLnZlbmRvciB8fFxuICAgICAgICAgICAgICAgICAgICBzZXJ2ZXJTdXBwb3J0ZWRUdW5uZWxUeXBlc1swXS5zaWduYXR1cmUgIT0gY2xpZW50U3VwcG9ydGVkVHVubmVsVHlwZXNbMF0uc2lnbmF0dXJlKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiQ2xpZW50J3MgdHVubmVsIHR5cGUgaGFkIHRoZSBpbmNvcnJlY3QgdmVuZG9yIG9yIHNpZ25hdHVyZVwiKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5zZW5kKFswLCAwLCAwLCAwXSk7ICAvLyB1c2UgTk9UVU5ORUxcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7IC8vIHdhaXQgdW50aWwgd2UgcmVjZWl2ZSB0aGUgc3ViIGF1dGggY291bnQgdG8gY29udGludWVcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJTZXJ2ZXIgd2FudGVkIHR1bm5lbHMsIGJ1dCBkb2Vzbid0IHN1cHBvcnQgdGhlIG5vdHVubmVsIHR5cGVcIik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgX25lZ290aWF0ZV90aWdodF9hdXRoOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpZiAoIXRoaXMuX3JmYl90aWdodHZuYykgeyAgLy8gZmlyc3QgcGFzcywgZG8gdGhlIHR1bm5lbCBuZWdvdGlhdGlvblxuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIm51bSB0dW5uZWxzXCIsIDQpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgICAgIHZhciBudW1UdW5uZWxzID0gdGhpcy5fc29jay5yUXNoaWZ0MzIoKTtcbiAgICAgICAgICAgICAgICBpZiAobnVtVHVubmVscyA+IDAgJiYgdGhpcy5fc29jay5yUXdhaXQoXCJ0dW5uZWwgY2FwYWJpbGl0aWVzXCIsIDE2ICogbnVtVHVubmVscywgNCkpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgICAgICB0aGlzLl9yZmJfdGlnaHR2bmMgPSB0cnVlO1xuXG4gICAgICAgICAgICAgICAgaWYgKG51bVR1bm5lbHMgPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX25lZ290aWF0ZV90aWdodF90dW5uZWxzKG51bVR1bm5lbHMpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7ICAvLyB3YWl0IHVudGlsIHdlIHJlY2VpdmUgdGhlIHN1YiBhdXRoIHRvIGNvbnRpbnVlXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBzZWNvbmQgcGFzcywgZG8gdGhlIHN1Yi1hdXRoIG5lZ290aWF0aW9uXG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJzdWIgYXV0aCBjb3VudFwiLCA0KSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgIHZhciBzdWJBdXRoQ291bnQgPSB0aGlzLl9zb2NrLnJRc2hpZnQzMigpO1xuICAgICAgICAgICAgaWYgKHN1YkF1dGhDb3VudCA9PT0gMCkgeyAgLy8gZW1wdHkgc3ViLWF1dGggbGlzdCByZWNlaXZlZCBtZWFucyAnbm8gYXV0aCcgc3VidHlwZSBzZWxlY3RlZFxuICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdTZWN1cml0eVJlc3VsdCcpO1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJzdWIgYXV0aCBjYXBhYmlsaXRpZXNcIiwgMTYgKiBzdWJBdXRoQ291bnQsIDQpKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgICAgICAgICB2YXIgY2xpZW50U3VwcG9ydGVkVHlwZXMgPSB7XG4gICAgICAgICAgICAgICAgJ1NURFZOT0FVVEhfXyc6IDEsXG4gICAgICAgICAgICAgICAgJ1NURFZWTkNBVVRIXyc6IDJcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIHZhciBzZXJ2ZXJTdXBwb3J0ZWRUeXBlcyA9IFtdO1xuXG4gICAgICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHN1YkF1dGhDb3VudDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgdmFyIGNhcE51bSA9IHRoaXMuX3NvY2suclFzaGlmdDMyKCk7XG4gICAgICAgICAgICAgICAgdmFyIGNhcGFiaWxpdGllcyA9IHRoaXMuX3NvY2suclFzaGlmdFN0cigxMik7XG4gICAgICAgICAgICAgICAgc2VydmVyU3VwcG9ydGVkVHlwZXMucHVzaChjYXBhYmlsaXRpZXMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmb3IgKHZhciBhdXRoVHlwZSBpbiBjbGllbnRTdXBwb3J0ZWRUeXBlcykge1xuICAgICAgICAgICAgICAgIGlmIChzZXJ2ZXJTdXBwb3J0ZWRUeXBlcy5pbmRleE9mKGF1dGhUeXBlKSAhPSAtMSkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnNlbmQoWzAsIDAsIDAsIGNsaWVudFN1cHBvcnRlZFR5cGVzW2F1dGhUeXBlXV0pO1xuXG4gICAgICAgICAgICAgICAgICAgIHN3aXRjaCAoYXV0aFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJ1NURFZOT0FVVEhfXyc6ICAvLyBubyBhdXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ1NlY3VyaXR5UmVzdWx0Jyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYXNlICdTVERWVk5DQVVUSF8nOiAvLyBWTkMgYXV0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3JmYl9hdXRoX3NjaGVtZSA9IDI7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2luaXRfbXNnKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiVW5zdXBwb3J0ZWQgdGlueSBhdXRoIHNjaGVtZTogXCIgKyBhdXRoVHlwZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiTm8gc3VwcG9ydGVkIHN1Yi1hdXRoIHR5cGVzIVwiKTtcbiAgICAgICAgfSxcblxuICAgICAgICBfbmVnb3RpYXRlX2F1dGhlbnRpY2F0aW9uOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBzd2l0Y2ggKHRoaXMuX3JmYl9hdXRoX3NjaGVtZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgMDogIC8vIGNvbm5lY3Rpb24gZmFpbGVkXG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcImF1dGggcmVhc29uXCIsIDQpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgICAgICAgICB2YXIgc3RybGVuID0gdGhpcy5fc29jay5yUXNoaWZ0MzIoKTtcbiAgICAgICAgICAgICAgICAgICAgdmFyIHJlYXNvbiA9IHRoaXMuX3NvY2suclFzaGlmdFN0cihzdHJsZW4pO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChcIkF1dGggZmFpbHVyZTogXCIgKyByZWFzb24pO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAxOiAgLy8gbm8gYXV0aFxuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcmZiX3ZlcnNpb24gPj0gMy44KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVTdGF0ZSgnU2VjdXJpdHlSZXN1bHQnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdDbGllbnRJbml0aWFsaXNhdGlvbicsIFwiTm8gYXV0aCByZXF1aXJlZFwiKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2luaXRfbXNnKCk7XG5cbiAgICAgICAgICAgICAgICBjYXNlIDIyOiAgLy8gWFZQIGF1dGhcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX25lZ290aWF0ZV94dnBfYXV0aCgpO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAyOiAgLy8gVk5DIGF1dGhlbnRpY2F0aW9uXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9uZWdvdGlhdGVfc3RkX3ZuY19hdXRoKCk7XG5cbiAgICAgICAgICAgICAgICBjYXNlIDE2OiAgLy8gVGlnaHRWTkMgU2VjdXJpdHkgVHlwZVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fbmVnb3RpYXRlX3RpZ2h0X2F1dGgoKTtcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiVW5zdXBwb3J0ZWQgYXV0aCBzY2hlbWU6IFwiICsgdGhpcy5fcmZiX2F1dGhfc2NoZW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBfaGFuZGxlX3NlY3VyaXR5X3Jlc3VsdDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KCdWTkMgYXV0aCByZXNwb25zZSAnLCA0KSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgIHN3aXRjaCAodGhpcy5fc29jay5yUXNoaWZ0MzIoKSkge1xuICAgICAgICAgICAgICAgIGNhc2UgMDogIC8vIE9LXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdDbGllbnRJbml0aWFsaXNhdGlvbicsICdBdXRoZW50aWNhdGlvbiBPSycpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5faW5pdF9tc2coKTtcbiAgICAgICAgICAgICAgICBjYXNlIDE6ICAvLyBmYWlsZWRcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3JmYl92ZXJzaW9uID49IDMuOCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdmFyIGxlbmd0aCA9IHRoaXMuX3NvY2suclFzaGlmdDMyKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJTZWN1cml0eVJlc3VsdCByZWFzb25cIiwgbGVuZ3RoLCA4KSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgICAgICAgICAgICAgIHZhciByZWFzb24gPSB0aGlzLl9zb2NrLnJRc2hpZnRTdHIobGVuZ3RoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKHJlYXNvbik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZmFpbChcIkF1dGhlbnRpY2F0aW9uIGZhaWx1cmVcIik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgIGNhc2UgMjpcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJUb28gbWFueSBhdXRoIGF0dGVtcHRzXCIpO1xuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiVW5rbm93biBTZWN1cml0eVJlc3VsdFwiKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBfbmVnb3RpYXRlX3NlcnZlcl9pbml0OiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJzZXJ2ZXIgaW5pdGlhbGl6YXRpb25cIiwgMjQpKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgICAgICAgICAvKiBTY3JlZW4gc2l6ZSAqL1xuICAgICAgICAgICAgdGhpcy5fZmJfd2lkdGggID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgIHRoaXMuX2ZiX2hlaWdodCA9IHRoaXMuX3NvY2suclFzaGlmdDE2KCk7XG4gICAgICAgICAgICB0aGlzLl9kZXN0QnVmZiA9IG5ldyBVaW50OEFycmF5KHRoaXMuX2ZiX3dpZHRoICogdGhpcy5fZmJfaGVpZ2h0ICogNCk7XG5cbiAgICAgICAgICAgIC8qIFBJWEVMX0ZPUk1BVCAqL1xuICAgICAgICAgICAgdmFyIGJwcCAgICAgICAgID0gdGhpcy5fc29jay5yUXNoaWZ0OCgpO1xuICAgICAgICAgICAgdmFyIGRlcHRoICAgICAgID0gdGhpcy5fc29jay5yUXNoaWZ0OCgpO1xuICAgICAgICAgICAgdmFyIGJpZ19lbmRpYW4gID0gdGhpcy5fc29jay5yUXNoaWZ0OCgpO1xuICAgICAgICAgICAgdmFyIHRydWVfY29sb3IgID0gdGhpcy5fc29jay5yUXNoaWZ0OCgpO1xuXG4gICAgICAgICAgICB2YXIgcmVkX21heCAgICAgPSB0aGlzLl9zb2NrLnJRc2hpZnQxNigpO1xuICAgICAgICAgICAgdmFyIGdyZWVuX21heCAgID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgIHZhciBibHVlX21heCAgICA9IHRoaXMuX3NvY2suclFzaGlmdDE2KCk7XG4gICAgICAgICAgICB2YXIgcmVkX3NoaWZ0ICAgPSB0aGlzLl9zb2NrLnJRc2hpZnQ4KCk7XG4gICAgICAgICAgICB2YXIgZ3JlZW5fc2hpZnQgPSB0aGlzLl9zb2NrLnJRc2hpZnQ4KCk7XG4gICAgICAgICAgICB2YXIgYmx1ZV9zaGlmdCAgPSB0aGlzLl9zb2NrLnJRc2hpZnQ4KCk7XG4gICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKDMpOyAgLy8gcGFkZGluZ1xuXG4gICAgICAgICAgICAvLyBOQihkaXJlY3R4bWFuMTIpOiB3ZSBkb24ndCB3YW50IHRvIGNhbGwgYW55IGNhbGxiYWNrcyBvciBwcmludCBtZXNzYWdlcyB1bnRpbFxuICAgICAgICAgICAgLy8gICAgICAgICAgICAgICAgICAgKmFmdGVyKiB3ZSdyZSBwYXN0IHRoZSBwb2ludCB3aGVyZSB3ZSBjb3VsZCBiYWNrdHJhY2tcblxuICAgICAgICAgICAgLyogQ29ubmVjdGlvbiBuYW1lL3RpdGxlICovXG4gICAgICAgICAgICB2YXIgbmFtZV9sZW5ndGggPSB0aGlzLl9zb2NrLnJRc2hpZnQzMigpO1xuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KCdzZXJ2ZXIgaW5pdCBuYW1lJywgbmFtZV9sZW5ndGgsIDI0KSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgIHRoaXMuX2ZiX25hbWUgPSBVdGlsLmRlY29kZVVURjgodGhpcy5fc29jay5yUXNoaWZ0U3RyKG5hbWVfbGVuZ3RoKSk7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9yZmJfdGlnaHR2bmMpIHtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoJ1RpZ2h0Vk5DIGV4dGVuZGVkIHNlcnZlciBpbml0IGhlYWRlcicsIDgsIDI0ICsgbmFtZV9sZW5ndGgpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgICAgIC8vIEluIFRpZ2h0Vk5DIG1vZGUsIFNlcnZlckluaXQgbWVzc2FnZSBpcyBleHRlbmRlZFxuICAgICAgICAgICAgICAgIHZhciBudW1TZXJ2ZXJNZXNzYWdlcyA9IHRoaXMuX3NvY2suclFzaGlmdDE2KCk7XG4gICAgICAgICAgICAgICAgdmFyIG51bUNsaWVudE1lc3NhZ2VzID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgICAgICB2YXIgbnVtRW5jb2RpbmdzID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKDIpOyAgLy8gcGFkZGluZ1xuXG4gICAgICAgICAgICAgICAgdmFyIHRvdGFsTWVzc2FnZXNMZW5ndGggPSAobnVtU2VydmVyTWVzc2FnZXMgKyBudW1DbGllbnRNZXNzYWdlcyArIG51bUVuY29kaW5ncykgKiAxNjtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoJ1RpZ2h0Vk5DIGV4dGVuZGVkIHNlcnZlciBpbml0IGhlYWRlcicsIHRvdGFsTWVzc2FnZXNMZW5ndGgsIDMyICsgbmFtZV9sZW5ndGgpKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgICAgICAgICAgICAgLy8gd2UgZG9uJ3QgYWN0dWFsbHkgZG8gYW55dGhpbmcgd2l0aCB0aGUgY2FwYWJpbGl0eSBpbmZvcm1hdGlvbiB0aGF0IFRJR0hUIHNlbmRzLFxuICAgICAgICAgICAgICAgIC8vIHNvIHdlIGp1c3Qgc2tpcCB0aGUgYWxsIG9mIHRoaXMuXG5cbiAgICAgICAgICAgICAgICAvLyBUSUdIVCBzZXJ2ZXIgbWVzc2FnZSBjYXBhYmlsaXRpZXNcbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKDE2ICogbnVtU2VydmVyTWVzc2FnZXMpO1xuXG4gICAgICAgICAgICAgICAgLy8gVElHSFQgY2xpZW50IG1lc3NhZ2UgY2FwYWJpbGl0aWVzXG4gICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygxNiAqIG51bUNsaWVudE1lc3NhZ2VzKTtcblxuICAgICAgICAgICAgICAgIC8vIFRJR0hUIGVuY29kaW5nIGNhcGFiaWxpdGllc1xuICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwQnl0ZXMoMTYgKiBudW1FbmNvZGluZ3MpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBOQihkaXJlY3R4bWFuMTIpOiB0aGVzZSBhcmUgZG93biBoZXJlIHNvIHRoYXQgd2UgZG9uJ3QgcnVuIHRoZW0gbXVsdGlwbGUgdGltZXNcbiAgICAgICAgICAgIC8vICAgICAgICAgICAgICAgICAgIGlmIHdlIGJhY2t0cmFja1xuICAgICAgICAgICAgVXRpbC5JbmZvKFwiU2NyZWVuOiBcIiArIHRoaXMuX2ZiX3dpZHRoICsgXCJ4XCIgKyB0aGlzLl9mYl9oZWlnaHQgK1xuICAgICAgICAgICAgICAgICAgICAgIFwiLCBicHA6IFwiICsgYnBwICsgXCIsIGRlcHRoOiBcIiArIGRlcHRoICtcbiAgICAgICAgICAgICAgICAgICAgICBcIiwgYmlnX2VuZGlhbjogXCIgKyBiaWdfZW5kaWFuICtcbiAgICAgICAgICAgICAgICAgICAgICBcIiwgdHJ1ZV9jb2xvcjogXCIgKyB0cnVlX2NvbG9yICtcbiAgICAgICAgICAgICAgICAgICAgICBcIiwgcmVkX21heDogXCIgKyByZWRfbWF4ICtcbiAgICAgICAgICAgICAgICAgICAgICBcIiwgZ3JlZW5fbWF4OiBcIiArIGdyZWVuX21heCArXG4gICAgICAgICAgICAgICAgICAgICAgXCIsIGJsdWVfbWF4OiBcIiArIGJsdWVfbWF4ICtcbiAgICAgICAgICAgICAgICAgICAgICBcIiwgcmVkX3NoaWZ0OiBcIiArIHJlZF9zaGlmdCArXG4gICAgICAgICAgICAgICAgICAgICAgXCIsIGdyZWVuX3NoaWZ0OiBcIiArIGdyZWVuX3NoaWZ0ICtcbiAgICAgICAgICAgICAgICAgICAgICBcIiwgYmx1ZV9zaGlmdDogXCIgKyBibHVlX3NoaWZ0KTtcblxuICAgICAgICAgICAgaWYgKGJpZ19lbmRpYW4gIT09IDApIHtcbiAgICAgICAgICAgICAgICBVdGlsLldhcm4oXCJTZXJ2ZXIgbmF0aXZlIGVuZGlhbiBpcyBub3QgbGl0dGxlIGVuZGlhblwiKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHJlZF9zaGlmdCAhPT0gMTYpIHtcbiAgICAgICAgICAgICAgICBVdGlsLldhcm4oXCJTZXJ2ZXIgbmF0aXZlIHJlZC1zaGlmdCBpcyBub3QgMTZcIik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChibHVlX3NoaWZ0ICE9PSAwKSB7XG4gICAgICAgICAgICAgICAgVXRpbC5XYXJuKFwiU2VydmVyIG5hdGl2ZSBibHVlLXNoaWZ0IGlzIG5vdCAwXCIpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyB3ZSdyZSBwYXN0IHRoZSBwb2ludCB3aGVyZSB3ZSBjb3VsZCBiYWNrdHJhY2ssIHNvIGl0J3Mgc2FmZSB0byBjYWxsIHRoaXNcbiAgICAgICAgICAgIHRoaXMuX29uRGVza3RvcE5hbWUodGhpcywgdGhpcy5fZmJfbmFtZSk7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl90cnVlX2NvbG9yICYmIHRoaXMuX2ZiX25hbWUgPT09IFwiSW50ZWwocikgQU1UIEtWTVwiKSB7XG4gICAgICAgICAgICAgICAgVXRpbC5XYXJuKFwiSW50ZWwgQU1UIEtWTSBvbmx5IHN1cHBvcnRzIDgvMTYgYml0IGRlcHRocy4gIERpc2FibGluZyB0cnVlIGNvbG9yXCIpO1xuICAgICAgICAgICAgICAgIHRoaXMuX3RydWVfY29sb3IgPSBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5zZXRfdHJ1ZV9jb2xvcih0aGlzLl90cnVlX2NvbG9yKTtcbiAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkucmVzaXplKHRoaXMuX2ZiX3dpZHRoLCB0aGlzLl9mYl9oZWlnaHQpO1xuICAgICAgICAgICAgdGhpcy5fb25GQlJlc2l6ZSh0aGlzLCB0aGlzLl9mYl93aWR0aCwgdGhpcy5fZmJfaGVpZ2h0KTtcbiAgICAgICAgICAgIHRoaXMuX2tleWJvYXJkLmdyYWIoKTtcbiAgICAgICAgICAgIHRoaXMuX21vdXNlLmdyYWIoKTtcblxuICAgICAgICAgICAgaWYgKHRoaXMuX3RydWVfY29sb3IpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9mYl9CcHAgPSA0O1xuICAgICAgICAgICAgICAgIHRoaXMuX2ZiX2RlcHRoID0gMztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fZmJfQnBwID0gMTtcbiAgICAgICAgICAgICAgICB0aGlzLl9mYl9kZXB0aCA9IDE7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5waXhlbEZvcm1hdCh0aGlzLl9zb2NrLCB0aGlzLl9mYl9CcHAsIHRoaXMuX2ZiX2RlcHRoLCB0aGlzLl90cnVlX2NvbG9yKTtcbiAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5jbGllbnRFbmNvZGluZ3ModGhpcy5fc29jaywgdGhpcy5fZW5jb2RpbmdzLCB0aGlzLl9sb2NhbF9jdXJzb3IsIHRoaXMuX3RydWVfY29sb3IpO1xuICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmZiVXBkYXRlUmVxdWVzdHModGhpcy5fc29jaywgZmFsc2UsIHRoaXMuX2Rpc3BsYXkuZ2V0Q2xlYW5EaXJ0eVJlc2V0KCksIHRoaXMuX2ZiX3dpZHRoLCB0aGlzLl9mYl9oZWlnaHQpO1xuXG4gICAgICAgICAgICB0aGlzLl90aW1pbmcuZmJ1X3J0X3N0YXJ0ID0gKG5ldyBEYXRlKCkpLmdldFRpbWUoKTtcbiAgICAgICAgICAgIHRoaXMuX3RpbWluZy5waXhlbHMgPSAwO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5fZW5jcnlwdCkge1xuICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdub3JtYWwnLCAnQ29ubmVjdGVkIChlbmNyeXB0ZWQpIHRvOiAnICsgdGhpcy5fZmJfbmFtZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKCdub3JtYWwnLCAnQ29ubmVjdGVkICh1bmVuY3J5cHRlZCkgdG86ICcgKyB0aGlzLl9mYl9uYW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9pbml0X21zZzogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgc3dpdGNoICh0aGlzLl9yZmJfc3RhdGUpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdQcm90b2NvbFZlcnNpb24nOlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fbmVnb3RpYXRlX3Byb3RvY29sX3ZlcnNpb24oKTtcblxuICAgICAgICAgICAgICAgIGNhc2UgJ1NlY3VyaXR5JzpcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX25lZ290aWF0ZV9zZWN1cml0eSgpO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnQXV0aGVudGljYXRpb24nOlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fbmVnb3RpYXRlX2F1dGhlbnRpY2F0aW9uKCk7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdTZWN1cml0eVJlc3VsdCc6XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9oYW5kbGVfc2VjdXJpdHlfcmVzdWx0KCk7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdDbGllbnRJbml0aWFsaXNhdGlvbic6XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suc2VuZChbdGhpcy5fc2hhcmVkID8gMSA6IDBdKTsgLy8gQ2xpZW50SW5pdGlhbGlzYXRpb25cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlU3RhdGUoJ1NlcnZlckluaXRpYWxpc2F0aW9uJywgXCJBdXRoZW50aWNhdGlvbiBPS1wiKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdTZXJ2ZXJJbml0aWFsaXNhdGlvbic6XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9uZWdvdGlhdGVfc2VydmVyX2luaXQoKTtcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiVW5rbm93biBzdGF0ZTogXCIgKyB0aGlzLl9yZmJfc3RhdGUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIF9oYW5kbGVfc2V0X2NvbG91cl9tYXBfbXNnOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBVdGlsLkRlYnVnKFwiU2V0Q29sb3JNYXBFbnRyaWVzXCIpO1xuICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXA4KCk7ICAvLyBQYWRkaW5nXG5cbiAgICAgICAgICAgIHZhciBmaXJzdF9jb2xvdXIgPSB0aGlzLl9zb2NrLnJRc2hpZnQxNigpO1xuICAgICAgICAgICAgdmFyIG51bV9jb2xvdXJzID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdCgnU2V0Q29sb3JNYXBFbnRyaWVzJywgbnVtX2NvbG91cnMgKiA2LCA2KSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgZm9yICh2YXIgYyA9IDA7IGMgPCBudW1fY29sb3VyczsgYysrKSB7XG4gICAgICAgICAgICAgICAgdmFyIHJlZCA9IHBhcnNlSW50KHRoaXMuX3NvY2suclFzaGlmdDE2KCkgLyAyNTYsIDEwKTtcbiAgICAgICAgICAgICAgICB2YXIgZ3JlZW4gPSBwYXJzZUludCh0aGlzLl9zb2NrLnJRc2hpZnQxNigpIC8gMjU2LCAxMCk7XG4gICAgICAgICAgICAgICAgdmFyIGJsdWUgPSBwYXJzZUludCh0aGlzLl9zb2NrLnJRc2hpZnQxNigpIC8gMjU2LCAxMCk7XG4gICAgICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5zZXRfY29sb3VyTWFwKFtibHVlLCBncmVlbiwgcmVkXSwgZmlyc3RfY29sb3VyICsgYyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBVdGlsLkRlYnVnKFwiY29sb3VyTWFwOiBcIiArIHRoaXMuX2Rpc3BsYXkuZ2V0X2NvbG91ck1hcCgpKTtcbiAgICAgICAgICAgIFV0aWwuSW5mbyhcIlJlZ2lzdGVyZWQgXCIgKyBudW1fY29sb3VycyArIFwiIGNvbG91ck1hcCBlbnRyaWVzXCIpO1xuXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBfaGFuZGxlX3NlcnZlcl9jdXRfdGV4dDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIlNlcnZlckN1dFRleHRcIik7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJTZXJ2ZXJDdXRUZXh0IGhlYWRlclwiLCA3LCAxKSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwQnl0ZXMoMyk7ICAvLyBQYWRkaW5nXG4gICAgICAgICAgICB2YXIgbGVuZ3RoID0gdGhpcy5fc29jay5yUXNoaWZ0MzIoKTtcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlNlcnZlckN1dFRleHRcIiwgbGVuZ3RoLCA4KSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgdmFyIHRleHQgPSB0aGlzLl9zb2NrLnJRc2hpZnRTdHIobGVuZ3RoKTtcbiAgICAgICAgICAgIHRoaXMuX29uQ2xpcGJvYXJkKHRoaXMsIHRleHQpO1xuXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBfaGFuZGxlX3NlcnZlcl9mZW5jZV9tc2c6IGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiU2VydmVyRmVuY2UgaGVhZGVyXCIsIDgsIDEpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygzKTsgLy8gUGFkZGluZ1xuICAgICAgICAgICAgdmFyIGZsYWdzID0gdGhpcy5fc29jay5yUXNoaWZ0MzIoKTtcbiAgICAgICAgICAgIHZhciBsZW5ndGggPSB0aGlzLl9zb2NrLnJRc2hpZnQ4KCk7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlNlcnZlckZlbmNlIHBheWxvYWRcIiwgbGVuZ3RoLCA5KSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgaWYgKGxlbmd0aCA+IDY0KSB7XG4gICAgICAgICAgICAgICAgVXRpbC5XYXJuKFwiQmFkIHBheWxvYWQgbGVuZ3RoIChcIiArIGxlbmd0aCArIFwiKSBpbiBmZW5jZSByZXNwb25zZVwiKTtcbiAgICAgICAgICAgICAgICBsZW5ndGggPSA2NDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFyIHBheWxvYWQgPSB0aGlzLl9zb2NrLnJRc2hpZnRTdHIobGVuZ3RoKTtcblxuICAgICAgICAgICAgdGhpcy5fc3VwcG9ydHNGZW5jZSA9IHRydWU7XG5cbiAgICAgICAgICAgIC8qXG4gICAgICAgICAgICAgKiBGZW5jZSBmbGFnc1xuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqICAoMTw8MCkgIC0gQmxvY2tCZWZvcmVcbiAgICAgICAgICAgICAqICAoMTw8MSkgIC0gQmxvY2tBZnRlclxuICAgICAgICAgICAgICogICgxPDwyKSAgLSBTeW5jTmV4dFxuICAgICAgICAgICAgICogICgxPDwzMSkgLSBSZXF1ZXN0XG4gICAgICAgICAgICAgKi9cblxuICAgICAgICAgICAgaWYgKCEoZmxhZ3MgJiAoMTw8MzEpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9mYWlsKFwiVW5leHBlY3RlZCBmZW5jZSByZXNwb25zZVwiKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gRmlsdGVyIG91dCB1bnN1cHBvcnRlZCBmbGFnc1xuICAgICAgICAgICAgLy8gRklYTUU6IHN1cHBvcnQgc3luY05leHRcbiAgICAgICAgICAgIGZsYWdzICY9ICgxPDwwKSB8ICgxPDwxKTtcblxuICAgICAgICAgICAgLy8gQmxvY2tCZWZvcmUgYW5kIEJsb2NrQWZ0ZXIgYXJlIGF1dG9tYXRpY2FsbHkgaGFuZGxlZCBieVxuICAgICAgICAgICAgLy8gdGhlIGZhY3QgdGhhdCB3ZSBwcm9jZXNzIGVhY2ggaW5jb21pbmcgbWVzc2FnZVxuICAgICAgICAgICAgLy8gc3luY2hyb251b3NseS5cbiAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5jbGllbnRGZW5jZSh0aGlzLl9zb2NrLCBmbGFncywgcGF5bG9hZCk7XG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9oYW5kbGVfeHZwX21zZzogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiWFZQIHZlcnNpb24gYW5kIG1lc3NhZ2VcIiwgMywgMSkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcDgoKTsgIC8vIFBhZGRpbmdcbiAgICAgICAgICAgIHZhciB4dnBfdmVyID0gdGhpcy5fc29jay5yUXNoaWZ0OCgpO1xuICAgICAgICAgICAgdmFyIHh2cF9tc2cgPSB0aGlzLl9zb2NrLnJRc2hpZnQ4KCk7XG5cbiAgICAgICAgICAgIHN3aXRjaCAoeHZwX21zZykge1xuICAgICAgICAgICAgICAgIGNhc2UgMDogIC8vIFhWUF9GQUlMXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVN0YXRlKHRoaXMuX3JmYl9zdGF0ZSwgXCJPcGVyYXRpb24gRmFpbGVkXCIpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIDE6ICAvLyBYVlBfSU5JVFxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9yZmJfeHZwX3ZlciA9IHh2cF92ZXI7XG4gICAgICAgICAgICAgICAgICAgIFV0aWwuSW5mbyhcIlhWUCBleHRlbnNpb25zIGVuYWJsZWQgKHZlcnNpb24gXCIgKyB0aGlzLl9yZmJfeHZwX3ZlciArIFwiKVwiKTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fb25YdnBJbml0KHRoaXMuX3JmYl94dnBfdmVyKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmFpbChcIkRpc2Nvbm5lY3RlZDogaWxsZWdhbCBzZXJ2ZXIgWFZQIG1lc3NhZ2UgXCIgKyB4dnBfbXNnKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9ub3JtYWxfbXNnOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB2YXIgbXNnX3R5cGU7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9GQlUucmVjdHMgPiAwKSB7XG4gICAgICAgICAgICAgICAgbXNnX3R5cGUgPSAwO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBtc2dfdHlwZSA9IHRoaXMuX3NvY2suclFzaGlmdDgoKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3dpdGNoIChtc2dfdHlwZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgMDogIC8vIEZyYW1lYnVmZmVyVXBkYXRlXG4gICAgICAgICAgICAgICAgICAgIHZhciByZXQgPSB0aGlzLl9mcmFtZWJ1ZmZlclVwZGF0ZSgpO1xuICAgICAgICAgICAgICAgICAgICBpZiAocmV0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBSRkIubWVzc2FnZXMuZmJVcGRhdGVSZXF1ZXN0cyh0aGlzLl9zb2NrLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZW5hYmxlZENvbnRpbnVvdXNVcGRhdGVzLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5nZXRDbGVhbkRpcnR5UmVzZXQoKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZiX3dpZHRoLCB0aGlzLl9mYl9oZWlnaHQpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByZXQ7XG5cbiAgICAgICAgICAgICAgICBjYXNlIDE6ICAvLyBTZXRDb2xvck1hcEVudHJpZXNcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2hhbmRsZV9zZXRfY29sb3VyX21hcF9tc2coKTtcblxuICAgICAgICAgICAgICAgIGNhc2UgMjogIC8vIEJlbGxcbiAgICAgICAgICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIkJlbGxcIik7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX29uQmVsbCh0aGlzKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG5cbiAgICAgICAgICAgICAgICBjYXNlIDM6ICAvLyBTZXJ2ZXJDdXRUZXh0XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9oYW5kbGVfc2VydmVyX2N1dF90ZXh0KCk7XG5cbiAgICAgICAgICAgICAgICBjYXNlIDE1MDogLy8gRW5kT2ZDb250aW51b3VzVXBkYXRlc1xuICAgICAgICAgICAgICAgICAgICB2YXIgZmlyc3QgPSAhKHRoaXMuX3N1cHBvcnRzQ29udGludW91c1VwZGF0ZXMpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9zdXBwb3J0c0NvbnRpbnVvdXNVcGRhdGVzID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZW5hYmxlZENvbnRpbnVvdXNVcGRhdGVzID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgICAgIGlmIChmaXJzdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZW5hYmxlZENvbnRpbnVvdXNVcGRhdGVzID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZUNvbnRpbnVvdXNVcGRhdGVzKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBVdGlsLkluZm8oXCJFbmFibGluZyBjb250aW51b3VzIHVwZGF0ZXMuXCIpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gRklYTUU6IFdlIG5lZWQgdG8gc2VuZCBhIGZyYW1lYnVmZmVydXBkYXRlcmVxdWVzdCBoZXJlXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBpZiB3ZSBhZGQgc3VwcG9ydCBmb3IgdHVybmluZyBvZmYgY29udGludW91cyB1cGRhdGVzXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG5cbiAgICAgICAgICAgICAgICBjYXNlIDI0ODogLy8gU2VydmVyRmVuY2VcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2hhbmRsZV9zZXJ2ZXJfZmVuY2VfbXNnKCk7XG5cbiAgICAgICAgICAgICAgICBjYXNlIDI1MDogIC8vIFhWUFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5faGFuZGxlX3h2cF9tc2coKTtcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZhaWwoXCJEaXNjb25uZWN0ZWQ6IGlsbGVnYWwgc2VydmVyIG1lc3NhZ2UgdHlwZSBcIiArIG1zZ190eXBlKTtcbiAgICAgICAgICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcInNvY2suclFzbGljZSgwLCAzMCk6IFwiICsgdGhpcy5fc29jay5yUXNsaWNlKDAsIDMwKSk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIF9mcmFtZWJ1ZmZlclVwZGF0ZTogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdmFyIHJldCA9IHRydWU7XG4gICAgICAgICAgICB2YXIgbm93O1xuXG4gICAgICAgICAgICBpZiAodGhpcy5fRkJVLnJlY3RzID09PSAwKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiRkJVIGhlYWRlclwiLCAzLCAxKSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcDgoKTsgIC8vIFBhZGRpbmdcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUucmVjdHMgPSB0aGlzLl9zb2NrLnJRc2hpZnQxNigpO1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDA7XG4gICAgICAgICAgICAgICAgdGhpcy5fdGltaW5nLmN1cl9mYnUgPSAwO1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl90aW1pbmcuZmJ1X3J0X3N0YXJ0ID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBub3cgPSAobmV3IERhdGUoKSkuZ2V0VGltZSgpO1xuICAgICAgICAgICAgICAgICAgICBVdGlsLkluZm8oXCJGaXJzdCBGQlUgbGF0ZW5jeTogXCIgKyAobm93IC0gdGhpcy5fdGltaW5nLmZidV9ydF9zdGFydCkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgd2hpbGUgKHRoaXMuX0ZCVS5yZWN0cyA+IDApIHtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fcmZiX3N0YXRlICE9PSBcIm5vcm1hbFwiKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiRkJVXCIsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX0ZCVS5ieXRlcyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJyZWN0IGhlYWRlclwiLCAxMikpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICAgICAgICAgIC8qIE5ldyBGcmFtZWJ1ZmZlclVwZGF0ZSAqL1xuXG4gICAgICAgICAgICAgICAgICAgIHZhciBoZHIgPSB0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcygxMik7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS54ICAgICAgICA9IChoZHJbMF0gPDwgOCkgKyBoZHJbMV07XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS55ICAgICAgICA9IChoZHJbMl0gPDwgOCkgKyBoZHJbM107XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS53aWR0aCAgICA9IChoZHJbNF0gPDwgOCkgKyBoZHJbNV07XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5oZWlnaHQgICA9IChoZHJbNl0gPDwgOCkgKyBoZHJbN107XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5lbmNvZGluZyA9IHBhcnNlSW50KChoZHJbOF0gPDwgMjQpICsgKGhkcls5XSA8PCAxNikgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAoaGRyWzEwXSA8PCA4KSArIGhkclsxMV0sIDEwKTtcblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9vbkZCVVJlY2VpdmUodGhpcyxcbiAgICAgICAgICAgICAgICAgICAgICAgIHsneCc6IHRoaXMuX0ZCVS54LCAneSc6IHRoaXMuX0ZCVS55LFxuICAgICAgICAgICAgICAgICAgICAgICAgICd3aWR0aCc6IHRoaXMuX0ZCVS53aWR0aCwgJ2hlaWdodCc6IHRoaXMuX0ZCVS5oZWlnaHQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgJ2VuY29kaW5nJzogdGhpcy5fRkJVLmVuY29kaW5nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICdlbmNvZGluZ05hbWUnOiB0aGlzLl9lbmNOYW1lc1t0aGlzLl9GQlUuZW5jb2RpbmddfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCF0aGlzLl9lbmNOYW1lc1t0aGlzLl9GQlUuZW5jb2RpbmddKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9mYWlsKFwiRGlzY29ubmVjdGVkOiB1bnN1cHBvcnRlZCBlbmNvZGluZyBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5lbmNvZGluZyk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB0aGlzLl90aW1pbmcubGFzdF9mYnUgPSAobmV3IERhdGUoKSkuZ2V0VGltZSgpO1xuXG4gICAgICAgICAgICAgICAgcmV0ID0gdGhpcy5fZW5jSGFuZGxlcnNbdGhpcy5fRkJVLmVuY29kaW5nXSgpO1xuXG4gICAgICAgICAgICAgICAgbm93ID0gKG5ldyBEYXRlKCkpLmdldFRpbWUoKTtcbiAgICAgICAgICAgICAgICB0aGlzLl90aW1pbmcuY3VyX2ZidSArPSAobm93IC0gdGhpcy5fdGltaW5nLmxhc3RfZmJ1KTtcblxuICAgICAgICAgICAgICAgIGlmIChyZXQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZW5jU3RhdHNbdGhpcy5fRkJVLmVuY29kaW5nXVswXSsrO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9lbmNTdGF0c1t0aGlzLl9GQlUuZW5jb2RpbmddWzFdKys7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5waXhlbHMgKz0gdGhpcy5fRkJVLndpZHRoICogdGhpcy5fRkJVLmhlaWdodDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fdGltaW5nLnBpeGVscyA+PSAodGhpcy5fZmJfd2lkdGggKiB0aGlzLl9mYl9oZWlnaHQpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICgodGhpcy5fRkJVLndpZHRoID09PSB0aGlzLl9mYl93aWR0aCAmJiB0aGlzLl9GQlUuaGVpZ2h0ID09PSB0aGlzLl9mYl9oZWlnaHQpIHx8XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl90aW1pbmcuZmJ1X3J0X3N0YXJ0ID4gMCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdGltaW5nLmZ1bGxfZmJ1X3RvdGFsICs9IHRoaXMuX3RpbWluZy5jdXJfZmJ1O1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdGltaW5nLmZ1bGxfZmJ1X2NudCsrO1xuICAgICAgICAgICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiVGltaW5nIG9mIGZ1bGwgRkJVLCBjdXJyOiBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdGltaW5nLmN1cl9mYnUgKyBcIiwgdG90YWw6IFwiICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl90aW1pbmcuZnVsbF9mYnVfdG90YWwgKyBcIiwgY250OiBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdGltaW5nLmZ1bGxfZmJ1X2NudCArIFwiLCBhdmc6IFwiICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAodGhpcy5fdGltaW5nLmZ1bGxfZmJ1X3RvdGFsIC8gdGhpcy5fdGltaW5nLmZ1bGxfZmJ1X2NudCkpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3RpbWluZy5mYnVfcnRfc3RhcnQgPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB2YXIgZmJ1X3J0X2RpZmYgPSBub3cgLSB0aGlzLl90aW1pbmcuZmJ1X3J0X3N0YXJ0O1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdGltaW5nLmZidV9ydF90b3RhbCArPSBmYnVfcnRfZGlmZjtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5mYnVfcnRfY250Kys7XG4gICAgICAgICAgICAgICAgICAgICAgICBVdGlsLkluZm8oXCJmdWxsIEZCVSByb3VuZC10cmlwLCBjdXI6IFwiICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmYnVfcnRfZGlmZiArIFwiLCB0b3RhbDogXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3RpbWluZy5mYnVfcnRfdG90YWwgKyBcIiwgY250OiBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdGltaW5nLmZidV9ydF9jbnQgKyBcIiwgYXZnOiBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKHRoaXMuX3RpbWluZy5mYnVfcnRfdG90YWwgLyB0aGlzLl90aW1pbmcuZmJ1X3J0X2NudCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdGltaW5nLmZidV9ydF9zdGFydCA9IDA7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIXJldCkgeyByZXR1cm4gcmV0OyB9ICAvLyBuZWVkIG1vcmUgZGF0YVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aGlzLl9vbkZCVUNvbXBsZXRlKHRoaXMsXG4gICAgICAgICAgICAgICAgICAgIHsneCc6IHRoaXMuX0ZCVS54LCAneSc6IHRoaXMuX0ZCVS55LFxuICAgICAgICAgICAgICAgICAgICAgJ3dpZHRoJzogdGhpcy5fRkJVLndpZHRoLCAnaGVpZ2h0JzogdGhpcy5fRkJVLmhlaWdodCxcbiAgICAgICAgICAgICAgICAgICAgICdlbmNvZGluZyc6IHRoaXMuX0ZCVS5lbmNvZGluZyxcbiAgICAgICAgICAgICAgICAgICAgICdlbmNvZGluZ05hbWUnOiB0aGlzLl9lbmNOYW1lc1t0aGlzLl9GQlUuZW5jb2RpbmddfSk7XG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlOyAgLy8gV2UgZmluaXNoZWQgdGhpcyBGQlVcbiAgICAgICAgfSxcblxuICAgICAgICBfdXBkYXRlQ29udGludW91c1VwZGF0ZXM6IGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgaWYgKCF0aGlzLl9lbmFibGVkQ29udGludW91c1VwZGF0ZXMpIHsgcmV0dXJuOyB9XG5cbiAgICAgICAgICAgIFJGQi5tZXNzYWdlcy5lbmFibGVDb250aW51b3VzVXBkYXRlcyh0aGlzLl9zb2NrLCB0cnVlLCAwLCAwLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZiX3dpZHRoLCB0aGlzLl9mYl9oZWlnaHQpO1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIFV0aWwubWFrZV9wcm9wZXJ0aWVzKFJGQiwgW1xuICAgICAgICBbJ3RhcmdldCcsICd3bycsICdkb20nXSwgICAgICAgICAgICAgICAgLy8gVk5DIGRpc3BsYXkgcmVuZGVyaW5nIENhbnZhcyBvYmplY3RcbiAgICAgICAgWydmb2N1c0NvbnRhaW5lcicsICd3bycsICdkb20nXSwgICAgICAgIC8vIERPTSBlbGVtZW50IHRoYXQgY2FwdHVyZXMga2V5Ym9hcmQgaW5wdXRcbiAgICAgICAgWydlbmNyeXB0JywgJ3J3JywgJ2Jvb2wnXSwgICAgICAgICAgICAgIC8vIFVzZSBUTFMvU1NML3dzcyBlbmNyeXB0aW9uXG4gICAgICAgIFsndHJ1ZV9jb2xvcicsICdydycsICdib29sJ10sICAgICAgICAgICAvLyBSZXF1ZXN0IHRydWUgY29sb3IgcGl4ZWwgZGF0YVxuICAgICAgICBbJ2xvY2FsX2N1cnNvcicsICdydycsICdib29sJ10sICAgICAgICAgLy8gUmVxdWVzdCBsb2NhbGx5IHJlbmRlcmVkIGN1cnNvclxuICAgICAgICBbJ3NoYXJlZCcsICdydycsICdib29sJ10sICAgICAgICAgICAgICAgLy8gUmVxdWVzdCBzaGFyZWQgbW9kZVxuICAgICAgICBbJ3ZpZXdfb25seScsICdydycsICdib29sJ10sICAgICAgICAgICAgLy8gRGlzYWJsZSBjbGllbnQgbW91c2Uva2V5Ym9hcmRcbiAgICAgICAgWyd4dnBfcGFzc3dvcmRfc2VwJywgJ3J3JywgJ3N0ciddLCAgICAgIC8vIFNlcGFyYXRvciBmb3IgWFZQIHBhc3N3b3JkIGZpZWxkc1xuICAgICAgICBbJ2Rpc2Nvbm5lY3RUaW1lb3V0JywgJ3J3JywgJ2ludCddLCAgICAgLy8gVGltZSAocykgdG8gd2FpdCBmb3IgZGlzY29ubmVjdGlvblxuICAgICAgICBbJ3dzUHJvdG9jb2xzJywgJ3J3JywgJ2FyciddLCAgICAgICAgICAgLy8gUHJvdG9jb2xzIHRvIHVzZSBpbiB0aGUgV2ViU29ja2V0IGNvbm5lY3Rpb25cbiAgICAgICAgWydyZXBlYXRlcklEJywgJ3J3JywgJ3N0ciddLCAgICAgICAgICAgIC8vIFtVbHRyYVZOQ10gUmVwZWF0ZXJJRCB0byBjb25uZWN0IHRvXG4gICAgICAgIFsndmlld3BvcnREcmFnJywgJ3J3JywgJ2Jvb2wnXSwgICAgICAgICAvLyBNb3ZlIHRoZSB2aWV3cG9ydCBvbiBtb3VzZSBkcmFnc1xuXG4gICAgICAgIC8vIENhbGxiYWNrIGZ1bmN0aW9uc1xuICAgICAgICBbJ29uVXBkYXRlU3RhdGUnLCAncncnLCAnZnVuYyddLCAgICAgICAgLy8gb25VcGRhdGVTdGF0ZShyZmIsIHN0YXRlLCBvbGRzdGF0ZSwgc3RhdHVzTXNnKTogUkZCIHN0YXRlIHVwZGF0ZS9jaGFuZ2VcbiAgICAgICAgWydvblBhc3N3b3JkUmVxdWlyZWQnLCAncncnLCAnZnVuYyddLCAgIC8vIG9uUGFzc3dvcmRSZXF1aXJlZChyZmIpOiBWTkMgcGFzc3dvcmQgaXMgcmVxdWlyZWRcbiAgICAgICAgWydvbkNsaXBib2FyZCcsICdydycsICdmdW5jJ10sICAgICAgICAgIC8vIG9uQ2xpcGJvYXJkKHJmYiwgdGV4dCk6IFJGQiBjbGlwYm9hcmQgY29udGVudHMgcmVjZWl2ZWRcbiAgICAgICAgWydvbkJlbGwnLCAncncnLCAnZnVuYyddLCAgICAgICAgICAgICAgIC8vIG9uQmVsbChyZmIpOiBSRkIgQmVsbCBtZXNzYWdlIHJlY2VpdmVkXG4gICAgICAgIFsnb25GQlVSZWNlaXZlJywgJ3J3JywgJ2Z1bmMnXSwgICAgICAgICAvLyBvbkZCVVJlY2VpdmUocmZiLCBmYnUpOiBSRkIgRkJVIHJlY2VpdmVkIGJ1dCBub3QgeWV0IHByb2Nlc3NlZFxuICAgICAgICBbJ29uRkJVQ29tcGxldGUnLCAncncnLCAnZnVuYyddLCAgICAgICAgLy8gb25GQlVDb21wbGV0ZShyZmIsIGZidSk6IFJGQiBGQlUgcmVjZWl2ZWQgYW5kIHByb2Nlc3NlZFxuICAgICAgICBbJ29uRkJSZXNpemUnLCAncncnLCAnZnVuYyddLCAgICAgICAgICAgLy8gb25GQlJlc2l6ZShyZmIsIHdpZHRoLCBoZWlnaHQpOiBmcmFtZSBidWZmZXIgcmVzaXplZFxuICAgICAgICBbJ29uRGVza3RvcE5hbWUnLCAncncnLCAnZnVuYyddLCAgICAgICAgLy8gb25EZXNrdG9wTmFtZShyZmIsIG5hbWUpOiBkZXNrdG9wIG5hbWUgcmVjZWl2ZWRcbiAgICAgICAgWydvblh2cEluaXQnLCAncncnLCAnZnVuYyddICAgICAgICAgICAgIC8vIG9uWHZwSW5pdCh2ZXJzaW9uKTogWFZQIGV4dGVuc2lvbnMgYWN0aXZlIGZvciB0aGlzIGNvbm5lY3Rpb25cbiAgICBdKTtcblxuICAgIFJGQi5wcm90b3R5cGUuc2V0X2xvY2FsX2N1cnNvciA9IGZ1bmN0aW9uIChjdXJzb3IpIHtcbiAgICAgICAgaWYgKCFjdXJzb3IgfHwgKGN1cnNvciBpbiB7JzAnOiAxLCAnbm8nOiAxLCAnZmFsc2UnOiAxfSkpIHtcbiAgICAgICAgICAgIHRoaXMuX2xvY2FsX2N1cnNvciA9IGZhbHNlO1xuICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5kaXNhYmxlTG9jYWxDdXJzb3IoKTsgLy9Pbmx5IHNob3cgc2VydmVyLXNpZGUgY3Vyc29yXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fZGlzcGxheS5nZXRfY3Vyc29yX3VyaSgpKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fbG9jYWxfY3Vyc29yID0gdHJ1ZTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgVXRpbC5XYXJuKFwiQnJvd3NlciBkb2VzIG5vdCBzdXBwb3J0IGxvY2FsIGN1cnNvclwiKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmRpc2FibGVMb2NhbEN1cnNvcigpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfTtcblxuICAgIFJGQi5wcm90b3R5cGUuZ2V0X2Rpc3BsYXkgPSBmdW5jdGlvbiAoKSB7IHJldHVybiB0aGlzLl9kaXNwbGF5OyB9O1xuICAgIFJGQi5wcm90b3R5cGUuZ2V0X2tleWJvYXJkID0gZnVuY3Rpb24gKCkgeyByZXR1cm4gdGhpcy5fa2V5Ym9hcmQ7IH07XG4gICAgUkZCLnByb3RvdHlwZS5nZXRfbW91c2UgPSBmdW5jdGlvbiAoKSB7IHJldHVybiB0aGlzLl9tb3VzZTsgfTtcblxuICAgIC8vIENsYXNzIE1ldGhvZHNcbiAgICBSRkIubWVzc2FnZXMgPSB7XG4gICAgICAgIGtleUV2ZW50OiBmdW5jdGlvbiAoc29jaywga2V5c3ltLCBkb3duKSB7XG4gICAgICAgICAgICB2YXIgYnVmZiA9IHNvY2suX3NRO1xuICAgICAgICAgICAgdmFyIG9mZnNldCA9IHNvY2suX3NRbGVuO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldF0gPSA0OyAgLy8gbXNnLXR5cGVcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMV0gPSBkb3duO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDJdID0gMDtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgM10gPSAwO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDRdID0gKGtleXN5bSA+PiAyNCk7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDVdID0gKGtleXN5bSA+PiAxNik7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDZdID0gKGtleXN5bSA+PiA4KTtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgN10gPSBrZXlzeW07XG5cbiAgICAgICAgICAgIHNvY2suX3NRbGVuICs9IDg7XG4gICAgICAgICAgICBzb2NrLmZsdXNoKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgUUVNVUV4dGVuZGVkS2V5RXZlbnQ6IGZ1bmN0aW9uIChzb2NrLCBrZXlzeW0sIGRvd24sIGtleWNvZGUpIHtcbiAgICAgICAgICAgIGZ1bmN0aW9uIGdldFJGQmtleWNvZGUoeHRfc2NhbmNvZGUpIHtcbiAgICAgICAgICAgICAgICB2YXIgdXBwZXJCeXRlID0gKGtleWNvZGUgPj4gOCk7XG4gICAgICAgICAgICAgICAgdmFyIGxvd2VyQnl0ZSA9IChrZXljb2RlICYgMHgwMGZmKTtcbiAgICAgICAgICAgICAgICBpZiAodXBwZXJCeXRlID09PSAweGUwICYmIGxvd2VyQnl0ZSA8IDB4N2YpIHtcbiAgICAgICAgICAgICAgICAgICAgbG93ZXJCeXRlID0gbG93ZXJCeXRlIHwgMHg4MDtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGxvd2VyQnl0ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIHh0X3NjYW5jb2RlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YXIgYnVmZiA9IHNvY2suX3NRO1xuICAgICAgICAgICAgdmFyIG9mZnNldCA9IHNvY2suX3NRbGVuO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldF0gPSAyNTU7IC8vIG1zZy10eXBlXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDFdID0gMDsgLy8gc3ViIG1zZy10eXBlXG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMl0gPSAoZG93biA+PiA4KTtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgM10gPSBkb3duO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDRdID0gKGtleXN5bSA+PiAyNCk7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDVdID0gKGtleXN5bSA+PiAxNik7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDZdID0gKGtleXN5bSA+PiA4KTtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgN10gPSBrZXlzeW07XG5cbiAgICAgICAgICAgIHZhciBSRkJrZXljb2RlID0gZ2V0UkZCa2V5Y29kZShrZXljb2RlKTtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA4XSA9IChSRkJrZXljb2RlID4+IDI0KTtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgOV0gPSAoUkZCa2V5Y29kZSA+PiAxNik7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDEwXSA9IChSRkJrZXljb2RlID4+IDgpO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxMV0gPSBSRkJrZXljb2RlO1xuXG4gICAgICAgICAgICBzb2NrLl9zUWxlbiArPSAxMjtcbiAgICAgICAgICAgIHNvY2suZmx1c2goKTtcbiAgICAgICAgfSxcblxuICAgICAgICBwb2ludGVyRXZlbnQ6IGZ1bmN0aW9uIChzb2NrLCB4LCB5LCBtYXNrKSB7XG4gICAgICAgICAgICB2YXIgYnVmZiA9IHNvY2suX3NRO1xuICAgICAgICAgICAgdmFyIG9mZnNldCA9IHNvY2suX3NRbGVuO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldF0gPSA1OyAvLyBtc2ctdHlwZVxuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDFdID0gbWFzaztcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAyXSA9IHggPj4gODtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgM10gPSB4O1xuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDRdID0geSA+PiA4O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA1XSA9IHk7XG5cbiAgICAgICAgICAgIHNvY2suX3NRbGVuICs9IDY7XG4gICAgICAgICAgICBzb2NrLmZsdXNoKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gVE9ETyhkaXJlY3R4bWFuMTIpOiBtYWtlIHRoaXMgdW5pY29kZSBjb21wYXRpYmxlP1xuICAgICAgICBjbGllbnRDdXRUZXh0OiBmdW5jdGlvbiAoc29jaywgdGV4dCkge1xuICAgICAgICAgICAgdmFyIGJ1ZmYgPSBzb2NrLl9zUTtcbiAgICAgICAgICAgIHZhciBvZmZzZXQgPSBzb2NrLl9zUWxlbjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXRdID0gNjsgLy8gbXNnLXR5cGVcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxXSA9IDA7IC8vIHBhZGRpbmdcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMl0gPSAwOyAvLyBwYWRkaW5nXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDNdID0gMDsgLy8gcGFkZGluZ1xuXG4gICAgICAgICAgICB2YXIgbiA9IHRleHQubGVuZ3RoO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDRdID0gbiA+PiAyNDtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNV0gPSBuID4+IDE2O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA2XSA9IG4gPj4gODtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgN10gPSBuO1xuXG4gICAgICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IG47IGkrKykge1xuICAgICAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgOCArIGldID0gIHRleHQuY2hhckNvZGVBdChpKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc29jay5fc1FsZW4gKz0gOCArIG47XG4gICAgICAgICAgICBzb2NrLmZsdXNoKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgc2V0RGVza3RvcFNpemU6IGZ1bmN0aW9uIChzb2NrLCB3aWR0aCwgaGVpZ2h0LCBpZCwgZmxhZ3MpIHtcbiAgICAgICAgICAgIHZhciBidWZmID0gc29jay5fc1E7XG4gICAgICAgICAgICB2YXIgb2Zmc2V0ID0gc29jay5fc1FsZW47XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0XSA9IDI1MTsgICAgICAgICAgICAgIC8vIG1zZy10eXBlXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDFdID0gMDsgICAgICAgICAgICAvLyBwYWRkaW5nXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDJdID0gd2lkdGggPj4gODsgICAvLyB3aWR0aFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAzXSA9IHdpZHRoO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA0XSA9IGhlaWdodCA+PiA4OyAgLy8gaGVpZ2h0XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDVdID0gaGVpZ2h0O1xuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDZdID0gMTsgICAgICAgICAgICAvLyBudW1iZXItb2Ytc2NyZWVuc1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA3XSA9IDA7ICAgICAgICAgICAgLy8gcGFkZGluZ1xuXG4gICAgICAgICAgICAvLyBzY3JlZW4gYXJyYXlcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgOF0gPSBpZCA+PiAyNDsgICAgIC8vIGlkXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDldID0gaWQgPj4gMTY7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDEwXSA9IGlkID4+IDg7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDExXSA9IGlkO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxMl0gPSAwOyAgICAgICAgICAgLy8geC1wb3NpdGlvblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxM10gPSAwO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxNF0gPSAwOyAgICAgICAgICAgLy8geS1wb3NpdGlvblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxNV0gPSAwO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxNl0gPSB3aWR0aCA+PiA4OyAgLy8gd2lkdGhcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTddID0gd2lkdGg7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDE4XSA9IGhlaWdodCA+PiA4OyAvLyBoZWlnaHRcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTldID0gaGVpZ2h0O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAyMF0gPSBmbGFncyA+PiAyNDsgLy8gZmxhZ3NcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMjFdID0gZmxhZ3MgPj4gMTY7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDIyXSA9IGZsYWdzID4+IDg7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDIzXSA9IGZsYWdzO1xuXG4gICAgICAgICAgICBzb2NrLl9zUWxlbiArPSAyNDtcbiAgICAgICAgICAgIHNvY2suZmx1c2goKTtcbiAgICAgICAgfSxcblxuICAgICAgICBjbGllbnRGZW5jZTogZnVuY3Rpb24gKHNvY2ssIGZsYWdzLCBwYXlsb2FkKSB7XG4gICAgICAgICAgICB2YXIgYnVmZiA9IHNvY2suX3NRO1xuICAgICAgICAgICAgdmFyIG9mZnNldCA9IHNvY2suX3NRbGVuO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldF0gPSAyNDg7IC8vIG1zZy10eXBlXG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMV0gPSAwOyAvLyBwYWRkaW5nXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDJdID0gMDsgLy8gcGFkZGluZ1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAzXSA9IDA7IC8vIHBhZGRpbmdcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA0XSA9IGZsYWdzID4+IDI0OyAvLyBmbGFnc1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA1XSA9IGZsYWdzID4+IDE2O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA2XSA9IGZsYWdzID4+IDg7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDddID0gZmxhZ3M7XG5cbiAgICAgICAgICAgIHZhciBuID0gcGF5bG9hZC5sZW5ndGg7XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgOF0gPSBuOyAvLyBsZW5ndGhcblxuICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBuOyBpKyspIHtcbiAgICAgICAgICAgICAgICBidWZmW29mZnNldCArIDkgKyBpXSA9IHBheWxvYWQuY2hhckNvZGVBdChpKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc29jay5fc1FsZW4gKz0gOSArIG47XG4gICAgICAgICAgICBzb2NrLmZsdXNoKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgZW5hYmxlQ29udGludW91c1VwZGF0ZXM6IGZ1bmN0aW9uIChzb2NrLCBlbmFibGUsIHgsIHksIHdpZHRoLCBoZWlnaHQpIHtcbiAgICAgICAgICAgIHZhciBidWZmID0gc29jay5fc1E7XG4gICAgICAgICAgICB2YXIgb2Zmc2V0ID0gc29jay5fc1FsZW47XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0XSA9IDE1MDsgICAgICAgICAgICAgLy8gbXNnLXR5cGVcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMV0gPSBlbmFibGU7ICAgICAgLy8gZW5hYmxlLWZsYWdcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAyXSA9IHggPj4gODsgICAgICAvLyB4XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDNdID0geDtcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNF0gPSB5ID4+IDg7ICAgICAgLy8geVxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA1XSA9IHk7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDZdID0gd2lkdGggPj4gODsgIC8vIHdpZHRoXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDddID0gd2lkdGg7XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDhdID0gaGVpZ2h0ID4+IDg7IC8vIGhlaWdodFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA5XSA9IGhlaWdodDtcblxuICAgICAgICAgICAgc29jay5fc1FsZW4gKz0gMTA7XG4gICAgICAgICAgICBzb2NrLmZsdXNoKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgcGl4ZWxGb3JtYXQ6IGZ1bmN0aW9uIChzb2NrLCBicHAsIGRlcHRoLCB0cnVlX2NvbG9yKSB7XG4gICAgICAgICAgICB2YXIgYnVmZiA9IHNvY2suX3NRO1xuICAgICAgICAgICAgdmFyIG9mZnNldCA9IHNvY2suX3NRbGVuO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldF0gPSAwOyAgLy8gbXNnLXR5cGVcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxXSA9IDA7IC8vIHBhZGRpbmdcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMl0gPSAwOyAvLyBwYWRkaW5nXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDNdID0gMDsgLy8gcGFkZGluZ1xuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDRdID0gYnBwICogODsgICAgICAgICAgICAgLy8gYml0cy1wZXItcGl4ZWxcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgNV0gPSBkZXB0aCAqIDg7ICAgICAgICAgICAvLyBkZXB0aFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA2XSA9IDA7ICAgICAgICAgICAgICAgICAgIC8vIGxpdHRsZS1lbmRpYW5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgN10gPSB0cnVlX2NvbG9yID8gMSA6IDA7ICAvLyB0cnVlLWNvbG9yXG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgOF0gPSAwOyAgICAvLyByZWQtbWF4XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDldID0gMjU1OyAgLy8gcmVkLW1heFxuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDEwXSA9IDA7ICAgLy8gZ3JlZW4tbWF4XG4gICAgICAgICAgICBidWZmW29mZnNldCArIDExXSA9IDI1NTsgLy8gZ3JlZW4tbWF4XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTJdID0gMDsgICAvLyBibHVlLW1heFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxM10gPSAyNTU7IC8vIGJsdWUtbWF4XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTRdID0gMTY7ICAvLyByZWQtc2hpZnRcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMTVdID0gODsgICAvLyBncmVlbi1zaGlmdFxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxNl0gPSAwOyAgIC8vIGJsdWUtc2hpZnRcblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxN10gPSAwOyAgIC8vIHBhZGRpbmdcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMThdID0gMDsgICAvLyBwYWRkaW5nXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDE5XSA9IDA7ICAgLy8gcGFkZGluZ1xuXG4gICAgICAgICAgICBzb2NrLl9zUWxlbiArPSAyMDtcbiAgICAgICAgICAgIHNvY2suZmx1c2goKTtcbiAgICAgICAgfSxcblxuICAgICAgICBjbGllbnRFbmNvZGluZ3M6IGZ1bmN0aW9uIChzb2NrLCBlbmNvZGluZ3MsIGxvY2FsX2N1cnNvciwgdHJ1ZV9jb2xvcikge1xuICAgICAgICAgICAgdmFyIGJ1ZmYgPSBzb2NrLl9zUTtcbiAgICAgICAgICAgIHZhciBvZmZzZXQgPSBzb2NrLl9zUWxlbjtcblxuICAgICAgICAgICAgYnVmZltvZmZzZXRdID0gMjsgLy8gbXNnLXR5cGVcbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0ICsgMV0gPSAwOyAvLyBwYWRkaW5nXG5cbiAgICAgICAgICAgIC8vIG9mZnNldCArIDIgYW5kIG9mZnNldCArIDMgYXJlIGVuY29kaW5nIGNvdW50XG5cbiAgICAgICAgICAgIHZhciBpLCBqID0gb2Zmc2V0ICsgNCwgY250ID0gMDtcbiAgICAgICAgICAgIGZvciAoaSA9IDA7IGkgPCBlbmNvZGluZ3MubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgICBpZiAoZW5jb2RpbmdzW2ldWzBdID09PSBcIkN1cnNvclwiICYmICFsb2NhbF9jdXJzb3IpIHtcbiAgICAgICAgICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIlNraXBwaW5nIEN1cnNvciBwc2V1ZG8tZW5jb2RpbmdcIik7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChlbmNvZGluZ3NbaV1bMF0gPT09IFwiVElHSFRcIiAmJiAhdHJ1ZV9jb2xvcikge1xuICAgICAgICAgICAgICAgICAgICAvLyBUT0RPOiByZW1vdmUgdGhpcyB3aGVuIHdlIGhhdmUgdGlnaHQrbm9uLXRydWUtY29sb3JcbiAgICAgICAgICAgICAgICAgICAgVXRpbC5XYXJuKFwiU2tpcHBpbmcgdGlnaHQgYXMgaXQgaXMgb25seSBzdXBwb3J0ZWQgd2l0aCB0cnVlIGNvbG9yXCIpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBlbmMgPSBlbmNvZGluZ3NbaV1bMV07XG4gICAgICAgICAgICAgICAgICAgIGJ1ZmZbal0gPSBlbmMgPj4gMjQ7XG4gICAgICAgICAgICAgICAgICAgIGJ1ZmZbaiArIDFdID0gZW5jID4+IDE2O1xuICAgICAgICAgICAgICAgICAgICBidWZmW2ogKyAyXSA9IGVuYyA+PiA4O1xuICAgICAgICAgICAgICAgICAgICBidWZmW2ogKyAzXSA9IGVuYztcblxuICAgICAgICAgICAgICAgICAgICBqICs9IDQ7XG4gICAgICAgICAgICAgICAgICAgIGNudCsrO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAyXSA9IGNudCA+PiA4O1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAzXSA9IGNudDtcblxuICAgICAgICAgICAgc29jay5fc1FsZW4gKz0gaiAtIG9mZnNldDtcbiAgICAgICAgICAgIHNvY2suZmx1c2goKTtcbiAgICAgICAgfSxcblxuICAgICAgICBmYlVwZGF0ZVJlcXVlc3RzOiBmdW5jdGlvbiAoc29jaywgb25seU5vbkluYywgY2xlYW5EaXJ0eSwgZmJfd2lkdGgsIGZiX2hlaWdodCkge1xuICAgICAgICAgICAgdmFyIG9mZnNldEluY3JlbWVudCA9IDA7XG5cbiAgICAgICAgICAgIHZhciBjYiA9IGNsZWFuRGlydHkuY2xlYW5Cb3g7XG4gICAgICAgICAgICB2YXIgdywgaDtcbiAgICAgICAgICAgIGlmICghb25seU5vbkluYyAmJiAoY2IudyA+IDAgJiYgY2IuaCA+IDApKSB7XG4gICAgICAgICAgICAgICAgdyA9IHR5cGVvZiBjYi53ID09PSBcInVuZGVmaW5lZFwiID8gZmJfd2lkdGggOiBjYi53O1xuICAgICAgICAgICAgICAgIGggPSB0eXBlb2YgY2IuaCA9PT0gXCJ1bmRlZmluZWRcIiA/IGZiX2hlaWdodCA6IGNiLmg7XG4gICAgICAgICAgICAgICAgLy8gUmVxdWVzdCBpbmNyZW1lbnRhbCBmb3IgY2xlYW4gYm94XG4gICAgICAgICAgICAgICAgUkZCLm1lc3NhZ2VzLmZiVXBkYXRlUmVxdWVzdChzb2NrLCAxLCBjYi54LCBjYi55LCB3LCBoKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjbGVhbkRpcnR5LmRpcnR5Qm94ZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgICB2YXIgZGIgPSBjbGVhbkRpcnR5LmRpcnR5Qm94ZXNbaV07XG4gICAgICAgICAgICAgICAgLy8gRm9yY2UgYWxsIChub24taW5jcmVtZW50YWwpIGZvciBkaXJ0eSBib3hcbiAgICAgICAgICAgICAgICB3ID0gdHlwZW9mIGRiLncgPT09IFwidW5kZWZpbmVkXCIgPyBmYl93aWR0aCA6IGRiLnc7XG4gICAgICAgICAgICAgICAgaCA9IHR5cGVvZiBkYi5oID09PSBcInVuZGVmaW5lZFwiID8gZmJfaGVpZ2h0IDogZGIuaDtcbiAgICAgICAgICAgICAgICBSRkIubWVzc2FnZXMuZmJVcGRhdGVSZXF1ZXN0KHNvY2ssIDAsIGRiLngsIGRiLnksIHcsIGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIGZiVXBkYXRlUmVxdWVzdDogZnVuY3Rpb24gKHNvY2ssIGluY3JlbWVudGFsLCB4LCB5LCB3LCBoKSB7XG4gICAgICAgICAgICB2YXIgYnVmZiA9IHNvY2suX3NRO1xuICAgICAgICAgICAgdmFyIG9mZnNldCA9IHNvY2suX3NRbGVuO1xuXG4gICAgICAgICAgICBpZiAodHlwZW9mKHgpID09PSBcInVuZGVmaW5lZFwiKSB7IHggPSAwOyB9XG4gICAgICAgICAgICBpZiAodHlwZW9mKHkpID09PSBcInVuZGVmaW5lZFwiKSB7IHkgPSAwOyB9XG5cbiAgICAgICAgICAgIGJ1ZmZbb2Zmc2V0XSA9IDM7ICAvLyBtc2ctdHlwZVxuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAxXSA9IGluY3JlbWVudGFsO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDJdID0gKHggPj4gOCkgJiAweEZGO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyAzXSA9IHggJiAweEZGO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDRdID0gKHkgPj4gOCkgJiAweEZGO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA1XSA9IHkgJiAweEZGO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDZdID0gKHcgPj4gOCkgJiAweEZGO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA3XSA9IHcgJiAweEZGO1xuXG4gICAgICAgICAgICBidWZmW29mZnNldCArIDhdID0gKGggPj4gOCkgJiAweEZGO1xuICAgICAgICAgICAgYnVmZltvZmZzZXQgKyA5XSA9IGggJiAweEZGO1xuXG4gICAgICAgICAgICBzb2NrLl9zUWxlbiArPSAxMDtcbiAgICAgICAgICAgIHNvY2suZmx1c2goKTtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICBSRkIuZ2VuREVTID0gZnVuY3Rpb24gKHBhc3N3b3JkLCBjaGFsbGVuZ2UpIHtcbiAgICAgICAgdmFyIHBhc3N3ZCA9IFtdO1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHBhc3N3b3JkLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICBwYXNzd2QucHVzaChwYXNzd29yZC5jaGFyQ29kZUF0KGkpKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gKG5ldyBERVMocGFzc3dkKSkuZW5jcnlwdChjaGFsbGVuZ2UpO1xuICAgIH07XG5cbiAgICBSRkIuZXh0cmFjdF9kYXRhX3VyaSA9IGZ1bmN0aW9uIChhcnIpIHtcbiAgICAgICAgcmV0dXJuIFwiO2Jhc2U2NCxcIiArIEJhc2U2NC5lbmNvZGUoYXJyKTtcbiAgICB9O1xuXG4gICAgUkZCLmVuY29kaW5nSGFuZGxlcnMgPSB7XG4gICAgICAgIFJBVzogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX0ZCVS5saW5lcyA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5saW5lcyA9IHRoaXMuX0ZCVS5oZWlnaHQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IHRoaXMuX0ZCVS53aWR0aCAqIHRoaXMuX2ZiX0JwcDsgIC8vIGF0IGxlYXN0IGEgbGluZVxuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiUkFXXCIsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICB2YXIgY3VyX3kgPSB0aGlzLl9GQlUueSArICh0aGlzLl9GQlUuaGVpZ2h0IC0gdGhpcy5fRkJVLmxpbmVzKTtcbiAgICAgICAgICAgIHZhciBjdXJyX2hlaWdodCA9IE1hdGgubWluKHRoaXMuX0ZCVS5saW5lcyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIE1hdGguZmxvb3IodGhpcy5fc29jay5yUWxlbigpIC8gKHRoaXMuX0ZCVS53aWR0aCAqIHRoaXMuX2ZiX0JwcCkpKTtcbiAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuYmxpdEltYWdlKHRoaXMuX0ZCVS54LCBjdXJfeSwgdGhpcy5fRkJVLndpZHRoLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY3Vycl9oZWlnaHQsIHRoaXMuX3NvY2suZ2V0X3JRKCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLmdldF9yUWkoKSk7XG4gICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKHRoaXMuX0ZCVS53aWR0aCAqIGN1cnJfaGVpZ2h0ICogdGhpcy5fZmJfQnBwKTtcbiAgICAgICAgICAgIHRoaXMuX0ZCVS5saW5lcyAtPSBjdXJyX2hlaWdodDtcblxuICAgICAgICAgICAgaWYgKHRoaXMuX0ZCVS5saW5lcyA+IDApIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgPSB0aGlzLl9GQlUud2lkdGggKiB0aGlzLl9mYl9CcHA7ICAvLyBBdCBsZWFzdCBhbm90aGVyIGxpbmVcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLnJlY3RzLS07XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gMDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgQ09QWVJFQ1Q6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDQ7XG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJDT1BZUkVDVFwiLCA0KSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuY29weUltYWdlKHRoaXMuX3NvY2suclFzaGlmdDE2KCksIHRoaXMuX3NvY2suclFzaGlmdDE2KCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUueCwgdGhpcy5fRkJVLnksIHRoaXMuX0ZCVS53aWR0aCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5oZWlnaHQpO1xuXG4gICAgICAgICAgICB0aGlzLl9GQlUucmVjdHMtLTtcbiAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDA7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBSUkU6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHZhciBjb2xvcjtcbiAgICAgICAgICAgIGlmICh0aGlzLl9GQlUuc3VicmVjdHMgPT09IDApIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgPSA0ICsgdGhpcy5fZmJfQnBwO1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIlJSRVwiLCA0ICsgdGhpcy5fZmJfQnBwKSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUuc3VicmVjdHMgPSB0aGlzLl9zb2NrLnJRc2hpZnQzMigpO1xuICAgICAgICAgICAgICAgIGNvbG9yID0gdGhpcy5fc29jay5yUXNoaWZ0Qnl0ZXModGhpcy5fZmJfQnBwKTsgIC8vIEJhY2tncm91bmRcbiAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmZpbGxSZWN0KHRoaXMuX0ZCVS54LCB0aGlzLl9GQlUueSwgdGhpcy5fRkJVLndpZHRoLCB0aGlzLl9GQlUuaGVpZ2h0LCBjb2xvcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHdoaWxlICh0aGlzLl9GQlUuc3VicmVjdHMgPiAwICYmIHRoaXMuX3NvY2suclFsZW4oKSA+PSAodGhpcy5fZmJfQnBwICsgOCkpIHtcbiAgICAgICAgICAgICAgICBjb2xvciA9IHRoaXMuX3NvY2suclFzaGlmdEJ5dGVzKHRoaXMuX2ZiX0JwcCk7XG4gICAgICAgICAgICAgICAgdmFyIHggPSB0aGlzLl9zb2NrLnJRc2hpZnQxNigpO1xuICAgICAgICAgICAgICAgIHZhciB5ID0gdGhpcy5fc29jay5yUXNoaWZ0MTYoKTtcbiAgICAgICAgICAgICAgICB2YXIgd2lkdGggPSB0aGlzLl9zb2NrLnJRc2hpZnQxNigpO1xuICAgICAgICAgICAgICAgIHZhciBoZWlnaHQgPSB0aGlzLl9zb2NrLnJRc2hpZnQxNigpO1xuICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuZmlsbFJlY3QodGhpcy5fRkJVLnggKyB4LCB0aGlzLl9GQlUueSArIHksIHdpZHRoLCBoZWlnaHQsIGNvbG9yKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUuc3VicmVjdHMtLTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX0ZCVS5zdWJyZWN0cyA+IDApIHtcbiAgICAgICAgICAgICAgICB2YXIgY2h1bmsgPSBNYXRoLm1pbih0aGlzLl9ycmVfY2h1bmtfc3osIHRoaXMuX0ZCVS5zdWJyZWN0cyk7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gKHRoaXMuX2ZiX0JwcCArIDgpICogY2h1bms7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5yZWN0cy0tO1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDA7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIEhFWFRJTEU6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHZhciByUSA9IHRoaXMuX3NvY2suZ2V0X3JRKCk7XG4gICAgICAgICAgICB2YXIgclFpID0gdGhpcy5fc29jay5nZXRfclFpKCk7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9GQlUudGlsZXMgPT09IDApIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUudGlsZXNfeCA9IE1hdGguY2VpbCh0aGlzLl9GQlUud2lkdGggLyAxNik7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLnRpbGVzX3kgPSBNYXRoLmNlaWwodGhpcy5fRkJVLmhlaWdodCAvIDE2KTtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUudG90YWxfdGlsZXMgPSB0aGlzLl9GQlUudGlsZXNfeCAqIHRoaXMuX0ZCVS50aWxlc195O1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS50aWxlcyA9IHRoaXMuX0ZCVS50b3RhbF90aWxlcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgd2hpbGUgKHRoaXMuX0ZCVS50aWxlcyA+IDApIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgPSAxO1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIkhFWFRJTEUgc3ViZW5jb2RpbmdcIiwgdGhpcy5fRkJVLmJ5dGVzKSkgeyByZXR1cm4gZmFsc2U7IH1cbiAgICAgICAgICAgICAgICB2YXIgc3ViZW5jb2RpbmcgPSByUVtyUWldOyAgLy8gUGVla1xuICAgICAgICAgICAgICAgIGlmIChzdWJlbmNvZGluZyA+IDMwKSB7ICAvLyBSYXdcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmFpbChcIkRpc2Nvbm5lY3RlZDogaWxsZWdhbCBoZXh0aWxlIHN1YmVuY29kaW5nIFwiICsgc3ViZW5jb2RpbmcpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdmFyIHN1YnJlY3RzID0gMDtcbiAgICAgICAgICAgICAgICB2YXIgY3Vycl90aWxlID0gdGhpcy5fRkJVLnRvdGFsX3RpbGVzIC0gdGhpcy5fRkJVLnRpbGVzO1xuICAgICAgICAgICAgICAgIHZhciB0aWxlX3ggPSBjdXJyX3RpbGUgJSB0aGlzLl9GQlUudGlsZXNfeDtcbiAgICAgICAgICAgICAgICB2YXIgdGlsZV95ID0gTWF0aC5mbG9vcihjdXJyX3RpbGUgLyB0aGlzLl9GQlUudGlsZXNfeCk7XG4gICAgICAgICAgICAgICAgdmFyIHggPSB0aGlzLl9GQlUueCArIHRpbGVfeCAqIDE2O1xuICAgICAgICAgICAgICAgIHZhciB5ID0gdGhpcy5fRkJVLnkgKyB0aWxlX3kgKiAxNjtcbiAgICAgICAgICAgICAgICB2YXIgdyA9IE1hdGgubWluKDE2LCAodGhpcy5fRkJVLnggKyB0aGlzLl9GQlUud2lkdGgpIC0geCk7XG4gICAgICAgICAgICAgICAgdmFyIGggPSBNYXRoLm1pbigxNiwgKHRoaXMuX0ZCVS55ICsgdGhpcy5fRkJVLmhlaWdodCkgLSB5KTtcblxuICAgICAgICAgICAgICAgIC8vIEZpZ3VyZSBvdXQgaG93IG11Y2ggd2UgYXJlIGV4cGVjdGluZ1xuICAgICAgICAgICAgICAgIGlmIChzdWJlbmNvZGluZyAmIDB4MDEpIHsgIC8vIFJhd1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgKz0gdyAqIGggKiB0aGlzLl9mYl9CcHA7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YmVuY29kaW5nICYgMHgwMikgeyAgLy8gQmFja2dyb3VuZFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzICs9IHRoaXMuX2ZiX0JwcDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViZW5jb2RpbmcgJiAweDA0KSB7ICAvLyBGb3JlZ3JvdW5kXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgKz0gdGhpcy5fZmJfQnBwO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJlbmNvZGluZyAmIDB4MDgpIHsgIC8vIEFueVN1YnJlY3RzXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMrKzsgIC8vIFNpbmNlIHdlIGFyZW4ndCBzaGlmdGluZyBpdCBvZmZcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcImhleHRpbGUgc3VicmVjdHMgaGVhZGVyXCIsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJyZWN0cyA9IHJRW3JRaSArIHRoaXMuX0ZCVS5ieXRlcyAtIDFdOyAgLy8gUGVla1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHN1YmVuY29kaW5nICYgMHgxMCkgeyAgLy8gU3VicmVjdHNDb2xvdXJlZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyArPSBzdWJyZWN0cyAqICh0aGlzLl9mYl9CcHAgKyAyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzICs9IHN1YnJlY3RzICogMjtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcImhleHRpbGVcIiwgdGhpcy5fRkJVLmJ5dGVzKSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgICAgIC8vIFdlIGtub3cgdGhlIGVuY29kaW5nIGFuZCBoYXZlIGEgd2hvbGUgdGlsZVxuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5zdWJlbmNvZGluZyA9IHJRW3JRaV07XG4gICAgICAgICAgICAgICAgclFpKys7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX0ZCVS5zdWJlbmNvZGluZyA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fRkJVLmxhc3RzdWJlbmNvZGluZyAmIDB4MDEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIFdlaXJkOiBpZ25vcmUgYmxhbmtzIGFyZSBSQVdcbiAgICAgICAgICAgICAgICAgICAgICAgIFV0aWwuRGVidWcoXCIgICAgIElnbm9yaW5nIGJsYW5rIGFmdGVyIFJBV1wiKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuZmlsbFJlY3QoeCwgeSwgdywgaCwgdGhpcy5fRkJVLmJhY2tncm91bmQpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLl9GQlUuc3ViZW5jb2RpbmcgJiAweDAxKSB7ICAvLyBSYXdcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5ibGl0SW1hZ2UoeCwgeSwgdywgaCwgclEsIHJRaSk7XG4gICAgICAgICAgICAgICAgICAgIHJRaSArPSB0aGlzLl9GQlUuYnl0ZXMgLSAxO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9GQlUuc3ViZW5jb2RpbmcgJiAweDAyKSB7ICAvLyBCYWNrZ3JvdW5kXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fZmJfQnBwID09IDEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuYmFja2dyb3VuZCA9IHJRW3JRaV07XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIGZiX0JwcCBpcyA0XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJhY2tncm91bmQgPSBbclFbclFpXSwgclFbclFpICsgMV0sIHJRW3JRaSArIDJdLCByUVtyUWkgKyAzXV07XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICByUWkgKz0gdGhpcy5fZmJfQnBwO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9GQlUuc3ViZW5jb2RpbmcgJiAweDA0KSB7ICAvLyBGb3JlZ3JvdW5kXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fZmJfQnBwID09IDEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9GQlUuZm9yZWdyb3VuZCA9IHJRW3JRaV07XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIHRoaXMuX2ZiX0JwcCBpcyA0XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmZvcmVncm91bmQgPSBbclFbclFpXSwgclFbclFpICsgMV0sIHJRW3JRaSArIDJdLCByUVtyUWkgKyAzXV07XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICByUWkgKz0gdGhpcy5fZmJfQnBwO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5zdGFydFRpbGUoeCwgeSwgdywgaCwgdGhpcy5fRkJVLmJhY2tncm91bmQpO1xuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fRkJVLnN1YmVuY29kaW5nICYgMHgwOCkgeyAgLy8gQW55U3VicmVjdHNcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YnJlY3RzID0gclFbclFpXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJRaSsrO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBmb3IgKHZhciBzID0gMDsgcyA8IHN1YnJlY3RzOyBzKyspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YXIgY29sb3I7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX0ZCVS5zdWJlbmNvZGluZyAmIDB4MTApIHsgIC8vIFN1YnJlY3RzQ29sb3VyZWRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX2ZiX0JwcCA9PT0gMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3IgPSByUVtyUWldO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gX2ZiX0JwcCBpcyA0XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb2xvciA9IFtyUVtyUWldLCByUVtyUWkgKyAxXSwgclFbclFpICsgMl0sIHJRW3JRaSArIDNdXTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByUWkgKz0gdGhpcy5fZmJfQnBwO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbG9yID0gdGhpcy5fRkJVLmZvcmVncm91bmQ7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhciB4eSA9IHJRW3JRaV07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgclFpKys7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFyIHN4ID0gKHh5ID4+IDQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhciBzeSA9ICh4eSAmIDB4MGYpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFyIHdoID0gclFbclFpXTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByUWkrKztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YXIgc3cgPSAod2ggPj4gNCkgKyAxO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhciBzaCA9ICh3aCAmIDB4MGYpICsgMTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuc3ViVGlsZShzeCwgc3ksIHN3LCBzaCwgY29sb3IpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuZmluaXNoVGlsZSgpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnNldF9yUWkoclFpKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUubGFzdHN1YmVuY29kaW5nID0gdGhpcy5fRkJVLnN1YmVuY29kaW5nO1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyA9IDA7XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLnRpbGVzLS07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9GQlUudGlsZXMgPT09IDApIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9GQlUucmVjdHMtLTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgZ2V0VGlnaHRDTGVuZ3RoOiBmdW5jdGlvbiAoYXJyKSB7XG4gICAgICAgICAgICB2YXIgaGVhZGVyID0gMSwgZGF0YSA9IDA7XG4gICAgICAgICAgICBkYXRhICs9IGFyclswXSAmIDB4N2Y7XG4gICAgICAgICAgICBpZiAoYXJyWzBdICYgMHg4MCkge1xuICAgICAgICAgICAgICAgIGhlYWRlcisrO1xuICAgICAgICAgICAgICAgIGRhdGEgKz0gKGFyclsxXSAmIDB4N2YpIDw8IDc7XG4gICAgICAgICAgICAgICAgaWYgKGFyclsxXSAmIDB4ODApIHtcbiAgICAgICAgICAgICAgICAgICAgaGVhZGVyKys7XG4gICAgICAgICAgICAgICAgICAgIGRhdGEgKz0gYXJyWzJdIDw8IDE0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBbaGVhZGVyLCBkYXRhXTtcbiAgICAgICAgfSxcblxuICAgICAgICBkaXNwbGF5X3RpZ2h0OiBmdW5jdGlvbiAoaXNUaWdodFBORykge1xuICAgICAgICAgICAgaWYgKHRoaXMuX2ZiX2RlcHRoID09PSAxKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fZmFpbChcIlRpZ2h0IHByb3RvY29sIGhhbmRsZXIgb25seSBpbXBsZW1lbnRzIHRydWUgY29sb3IgbW9kZVwiKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gMTsgIC8vIGNvbXByZXNzaW9uLWNvbnRyb2wgYnl0ZVxuICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiVElHSFQgY29tcHJlc3Npb24tY29udHJvbFwiLCB0aGlzLl9GQlUuYnl0ZXMpKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgICAgICAgICB2YXIgY2hlY2tzdW0gPSBmdW5jdGlvbiAoZGF0YSkge1xuICAgICAgICAgICAgICAgIHZhciBzdW0gPSAwO1xuICAgICAgICAgICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZGF0YS5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgICAgICAgICBzdW0gKz0gZGF0YVtpXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1bSA+IDY1NTM2KSBzdW0gLT0gNjU1MzY7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBzdW07XG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICB2YXIgcmVzZXRTdHJlYW1zID0gMDtcbiAgICAgICAgICAgIHZhciBzdHJlYW1JZCA9IC0xO1xuICAgICAgICAgICAgdmFyIGRlY29tcHJlc3MgPSBmdW5jdGlvbiAoZGF0YSwgZXhwZWN0ZWQpIHtcbiAgICAgICAgICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IDQ7IGkrKykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoKHJlc2V0U3RyZWFtcyA+PiBpKSAmIDEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS56bGlic1tpXS5yZXNldCgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiUmVzZXQgemxpYiBzdHJlYW0gXCIgKyBpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vdmFyIHVuY29tcHJlc3NlZCA9IHRoaXMuX0ZCVS56bGlic1tzdHJlYW1JZF0udW5jb21wcmVzcyhkYXRhLCAwKTtcbiAgICAgICAgICAgICAgICB2YXIgdW5jb21wcmVzc2VkID0gdGhpcy5fRkJVLnpsaWJzW3N0cmVhbUlkXS5pbmZsYXRlKGRhdGEsIHRydWUsIGV4cGVjdGVkKTtcbiAgICAgICAgICAgICAgICAvKmlmICh1bmNvbXByZXNzZWQuc3RhdHVzICE9PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIFV0aWwuRXJyb3IoXCJJbnZhbGlkIGRhdGEgaW4gemxpYiBzdHJlYW1cIik7XG4gICAgICAgICAgICAgICAgfSovXG5cbiAgICAgICAgICAgICAgICAvL3JldHVybiB1bmNvbXByZXNzZWQuZGF0YTtcbiAgICAgICAgICAgICAgICByZXR1cm4gdW5jb21wcmVzc2VkO1xuICAgICAgICAgICAgfS5iaW5kKHRoaXMpO1xuXG4gICAgICAgICAgICB2YXIgaW5kZXhlZFRvUkdCWDJDb2xvciA9IGZ1bmN0aW9uIChkYXRhLCBwYWxldHRlLCB3aWR0aCwgaGVpZ2h0KSB7XG4gICAgICAgICAgICAgICAgLy8gQ29udmVydCBpbmRleGVkIChwYWxldHRlIGJhc2VkKSBpbWFnZSBkYXRhIHRvIFJHQlxuICAgICAgICAgICAgICAgIC8vIFRPRE86IHJlZHVjZSBudW1iZXIgb2YgY2FsY3VsYXRpb25zIGluc2lkZSBsb29wXG4gICAgICAgICAgICAgICAgdmFyIGRlc3QgPSB0aGlzLl9kZXN0QnVmZjtcbiAgICAgICAgICAgICAgICB2YXIgdyA9IE1hdGguZmxvb3IoKHdpZHRoICsgNykgLyA4KTtcbiAgICAgICAgICAgICAgICB2YXIgdzEgPSBNYXRoLmZsb29yKHdpZHRoIC8gOCk7XG5cbiAgICAgICAgICAgICAgICAvKmZvciAodmFyIHkgPSAwOyB5IDwgaGVpZ2h0OyB5KyspIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGIsIHgsIGRwLCBzcDtcbiAgICAgICAgICAgICAgICAgICAgdmFyIHlvZmZzZXQgPSB5ICogd2lkdGg7XG4gICAgICAgICAgICAgICAgICAgIHZhciB5Yml0b2Zmc2V0ID0geSAqIHc7XG4gICAgICAgICAgICAgICAgICAgIHZhciB4b2Zmc2V0LCB0YXJnZXRieXRlO1xuICAgICAgICAgICAgICAgICAgICBmb3IgKHggPSAwOyB4IDwgdzE7IHgrKykge1xuICAgICAgICAgICAgICAgICAgICAgICAgeG9mZnNldCA9IHlvZmZzZXQgKyB4ICogODtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldGJ5dGUgPSBkYXRhW3liaXRvZmZzZXQgKyB4XTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvciAoYiA9IDc7IGIgPj0gMDsgYi0tKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZHAgPSAoeG9mZnNldCArIDcgLSBiKSAqIDM7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3AgPSAodGFyZ2V0Ynl0ZSA+PiBiICYgMSkgKiAzO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RbZHBdID0gcGFsZXR0ZVtzcF07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVzdFtkcCArIDFdID0gcGFsZXR0ZVtzcCArIDFdO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RbZHAgKyAyXSA9IHBhbGV0dGVbc3AgKyAyXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHhvZmZzZXQgPSB5b2Zmc2V0ICsgeCAqIDg7XG4gICAgICAgICAgICAgICAgICAgIHRhcmdldGJ5dGUgPSBkYXRhW3liaXRvZmZzZXQgKyB4XTtcbiAgICAgICAgICAgICAgICAgICAgZm9yIChiID0gNzsgYiA+PSA4IC0gd2lkdGggJSA4OyBiLS0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRwID0gKHhvZmZzZXQgKyA3IC0gYikgKiAzO1xuICAgICAgICAgICAgICAgICAgICAgICAgc3AgPSAodGFyZ2V0Ynl0ZSA+PiBiICYgMSkgKiAzO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdFtkcF0gPSBwYWxldHRlW3NwXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RbZHAgKyAxXSA9IHBhbGV0dGVbc3AgKyAxXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RbZHAgKyAyXSA9IHBhbGV0dGVbc3AgKyAyXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0qL1xuXG4gICAgICAgICAgICAgICAgZm9yICh2YXIgeSA9IDA7IHkgPCBoZWlnaHQ7IHkrKykge1xuICAgICAgICAgICAgICAgICAgICB2YXIgYiwgeCwgZHAsIHNwO1xuICAgICAgICAgICAgICAgICAgICBmb3IgKHggPSAwOyB4IDwgdzE7IHgrKykge1xuICAgICAgICAgICAgICAgICAgICAgICAgZm9yIChiID0gNzsgYiA+PSAwOyBiLS0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkcCA9ICh5ICogd2lkdGggKyB4ICogOCArIDcgLSBiKSAqIDQ7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3AgPSAoZGF0YVt5ICogdyArIHhdID4+IGIgJiAxKSAqIDM7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVzdFtkcF0gPSBwYWxldHRlW3NwXTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0W2RwICsgMV0gPSBwYWxldHRlW3NwICsgMV07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVzdFtkcCArIDJdID0gcGFsZXR0ZVtzcCArIDJdO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RbZHAgKyAzXSA9IDI1NTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGZvciAoYiA9IDc7IGIgPj0gOCAtIHdpZHRoICUgODsgYi0tKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkcCA9ICh5ICogd2lkdGggKyB4ICogOCArIDcgLSBiKSAqIDQ7XG4gICAgICAgICAgICAgICAgICAgICAgICBzcCA9IChkYXRhW3kgKiB3ICsgeF0gPj4gYiAmIDEpICogMztcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RbZHBdID0gcGFsZXR0ZVtzcF07XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0W2RwICsgMV0gPSBwYWxldHRlW3NwICsgMV07XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0W2RwICsgMl0gPSBwYWxldHRlW3NwICsgMl07XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0W2RwICsgM10gPSAyNTU7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZGVzdDtcbiAgICAgICAgICAgIH0uYmluZCh0aGlzKTtcblxuICAgICAgICAgICAgdmFyIGluZGV4ZWRUb1JHQlggPSBmdW5jdGlvbiAoZGF0YSwgcGFsZXR0ZSwgd2lkdGgsIGhlaWdodCkge1xuICAgICAgICAgICAgICAgIC8vIENvbnZlcnQgaW5kZXhlZCAocGFsZXR0ZSBiYXNlZCkgaW1hZ2UgZGF0YSB0byBSR0JcbiAgICAgICAgICAgICAgICB2YXIgZGVzdCA9IHRoaXMuX2Rlc3RCdWZmO1xuICAgICAgICAgICAgICAgIHZhciB0b3RhbCA9IHdpZHRoICogaGVpZ2h0ICogNDtcbiAgICAgICAgICAgICAgICBmb3IgKHZhciBpID0gMCwgaiA9IDA7IGkgPCB0b3RhbDsgaSArPSA0LCBqKyspIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIHNwID0gZGF0YVtqXSAqIDM7XG4gICAgICAgICAgICAgICAgICAgIGRlc3RbaV0gPSBwYWxldHRlW3NwXTtcbiAgICAgICAgICAgICAgICAgICAgZGVzdFtpICsgMV0gPSBwYWxldHRlW3NwICsgMV07XG4gICAgICAgICAgICAgICAgICAgIGRlc3RbaSArIDJdID0gcGFsZXR0ZVtzcCArIDJdO1xuICAgICAgICAgICAgICAgICAgICBkZXN0W2kgKyAzXSA9IDI1NTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZGVzdDtcbiAgICAgICAgICAgIH0uYmluZCh0aGlzKTtcblxuICAgICAgICAgICAgdmFyIHJRaSA9IHRoaXMuX3NvY2suZ2V0X3JRaSgpO1xuICAgICAgICAgICAgdmFyIHJRID0gdGhpcy5fc29jay5yUXdob2xlKCk7XG4gICAgICAgICAgICB2YXIgY21vZGUsIGRhdGE7XG4gICAgICAgICAgICB2YXIgY2xfaGVhZGVyLCBjbF9kYXRhO1xuXG4gICAgICAgICAgICB2YXIgaGFuZGxlUGFsZXR0ZSA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICB2YXIgbnVtQ29sb3JzID0gclFbclFpICsgMl0gKyAxO1xuICAgICAgICAgICAgICAgIHZhciBwYWxldHRlU2l6ZSA9IG51bUNvbG9ycyAqIHRoaXMuX2ZiX2RlcHRoO1xuICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyArPSBwYWxldHRlU2l6ZTtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJUSUdIVCBwYWxldHRlIFwiICsgY21vZGUsIHRoaXMuX0ZCVS5ieXRlcykpIHsgcmV0dXJuIGZhbHNlOyB9XG5cbiAgICAgICAgICAgICAgICB2YXIgYnBwID0gKG51bUNvbG9ycyA8PSAyKSA/IDEgOiA4O1xuICAgICAgICAgICAgICAgIHZhciByb3dTaXplID0gTWF0aC5mbG9vcigodGhpcy5fRkJVLndpZHRoICogYnBwICsgNykgLyA4KTtcbiAgICAgICAgICAgICAgICB2YXIgcmF3ID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgaWYgKHJvd1NpemUgKiB0aGlzLl9GQlUuaGVpZ2h0IDwgMTIpIHtcbiAgICAgICAgICAgICAgICAgICAgcmF3ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgY2xfaGVhZGVyID0gMDtcbiAgICAgICAgICAgICAgICAgICAgY2xfZGF0YSA9IHJvd1NpemUgKiB0aGlzLl9GQlUuaGVpZ2h0O1xuICAgICAgICAgICAgICAgICAgICAvL2NsZW5ndGggPSBbMCwgcm93U2l6ZSAqIHRoaXMuX0ZCVS5oZWlnaHRdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGJlZ2luIGlubGluZSBnZXRUaWdodENMZW5ndGggKHJldHVybmluZyB0d28taXRlbSBhcnJheXMgaXMgYmFkIGZvciBwZXJmb3JtYW5jZSB3aXRoIEdDKVxuICAgICAgICAgICAgICAgICAgICB2YXIgY2xfb2Zmc2V0ID0gclFpICsgMyArIHBhbGV0dGVTaXplO1xuICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIgPSAxO1xuICAgICAgICAgICAgICAgICAgICBjbF9kYXRhID0gMDtcbiAgICAgICAgICAgICAgICAgICAgY2xfZGF0YSArPSByUVtjbF9vZmZzZXRdICYgMHg3ZjtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJRW2NsX29mZnNldF0gJiAweDgwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIrKztcbiAgICAgICAgICAgICAgICAgICAgICAgIGNsX2RhdGEgKz0gKHJRW2NsX29mZnNldCArIDFdICYgMHg3ZikgPDwgNztcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChyUVtjbF9vZmZzZXQgKyAxXSAmIDB4ODApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbF9oZWFkZXIrKztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbF9kYXRhICs9IHJRW2NsX29mZnNldCArIDJdIDw8IDE0O1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIC8vIGVuZCBpbmxpbmUgZ2V0VGlnaHRDTGVuZ3RoXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzICs9IGNsX2hlYWRlciArIGNsX2RhdGE7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiVElHSFQgXCIgKyBjbW9kZSwgdGhpcy5fRkJVLmJ5dGVzKSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgICAgIC8vIFNoaWZ0IGN0bCwgZmlsdGVyIGlkLCBudW0gY29sb3JzLCBwYWxldHRlIGVudHJpZXMsIGFuZCBjbGVuZ3RoIG9mZlxuICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwQnl0ZXMoMyk7XG4gICAgICAgICAgICAgICAgLy92YXIgcGFsZXR0ZSA9IHRoaXMuX3NvY2suclFzaGlmdEJ5dGVzKHBhbGV0dGVTaXplKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2hpZnRUbyh0aGlzLl9wYWxldHRlQnVmZiwgcGFsZXR0ZVNpemUpO1xuICAgICAgICAgICAgICAgIHRoaXMuX3NvY2suclFza2lwQnl0ZXMoY2xfaGVhZGVyKTtcblxuICAgICAgICAgICAgICAgIGlmIChyYXcpIHtcbiAgICAgICAgICAgICAgICAgICAgZGF0YSA9IHRoaXMuX3NvY2suclFzaGlmdEJ5dGVzKGNsX2RhdGEpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGRhdGEgPSBkZWNvbXByZXNzKHRoaXMuX3NvY2suclFzaGlmdEJ5dGVzKGNsX2RhdGEpLCByb3dTaXplICogdGhpcy5fRkJVLmhlaWdodCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy8gQ29udmVydCBpbmRleGVkIChwYWxldHRlIGJhc2VkKSBpbWFnZSBkYXRhIHRvIFJHQlxuICAgICAgICAgICAgICAgIHZhciByZ2J4O1xuICAgICAgICAgICAgICAgIGlmIChudW1Db2xvcnMgPT0gMikge1xuICAgICAgICAgICAgICAgICAgICByZ2J4ID0gaW5kZXhlZFRvUkdCWDJDb2xvcihkYXRhLCB0aGlzLl9wYWxldHRlQnVmZiwgdGhpcy5fRkJVLndpZHRoLCB0aGlzLl9GQlUuaGVpZ2h0KTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZGlzcGxheS5ibGl0UmdieEltYWdlKHRoaXMuX0ZCVS54LCB0aGlzLl9GQlUueSwgdGhpcy5fRkJVLndpZHRoLCB0aGlzLl9GQlUuaGVpZ2h0LCByZ2J4LCAwLCBmYWxzZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmdieCA9IGluZGV4ZWRUb1JHQlgoZGF0YSwgdGhpcy5fcGFsZXR0ZUJ1ZmYsIHRoaXMuX0ZCVS53aWR0aCwgdGhpcy5fRkJVLmhlaWdodCk7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkuYmxpdFJnYnhJbWFnZSh0aGlzLl9GQlUueCwgdGhpcy5fRkJVLnksIHRoaXMuX0ZCVS53aWR0aCwgdGhpcy5fRkJVLmhlaWdodCwgcmdieCwgMCwgZmFsc2UpO1xuICAgICAgICAgICAgICAgIH1cblxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9LmJpbmQodGhpcyk7XG5cbiAgICAgICAgICAgIHZhciBoYW5kbGVDb3B5ID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIHZhciByYXcgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICB2YXIgdW5jb21wcmVzc2VkU2l6ZSA9IHRoaXMuX0ZCVS53aWR0aCAqIHRoaXMuX0ZCVS5oZWlnaHQgKiB0aGlzLl9mYl9kZXB0aDtcbiAgICAgICAgICAgICAgICBpZiAodW5jb21wcmVzc2VkU2l6ZSA8IDEyKSB7XG4gICAgICAgICAgICAgICAgICAgIHJhdyA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGNsX2hlYWRlciA9IDA7XG4gICAgICAgICAgICAgICAgICAgIGNsX2RhdGEgPSB1bmNvbXByZXNzZWRTaXplO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGJlZ2luIGlubGluZSBnZXRUaWdodENMZW5ndGggKHJldHVybmluZyB0d28taXRlbSBhcnJheXMgaXMgZm9yIHBlZm9ybWFuY2Ugd2l0aCBHQylcbiAgICAgICAgICAgICAgICAgICAgdmFyIGNsX29mZnNldCA9IHJRaSArIDE7XG4gICAgICAgICAgICAgICAgICAgIGNsX2hlYWRlciA9IDE7XG4gICAgICAgICAgICAgICAgICAgIGNsX2RhdGEgPSAwO1xuICAgICAgICAgICAgICAgICAgICBjbF9kYXRhICs9IHJRW2NsX29mZnNldF0gJiAweDdmO1xuICAgICAgICAgICAgICAgICAgICBpZiAoclFbY2xfb2Zmc2V0XSAmIDB4ODApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNsX2hlYWRlcisrO1xuICAgICAgICAgICAgICAgICAgICAgICAgY2xfZGF0YSArPSAoclFbY2xfb2Zmc2V0ICsgMV0gJiAweDdmKSA8PCA3O1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHJRW2NsX29mZnNldCArIDFdICYgMHg4MCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsX2hlYWRlcisrO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsX2RhdGEgKz0gclFbY2xfb2Zmc2V0ICsgMl0gPDwgMTQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgLy8gZW5kIGlubGluZSBnZXRUaWdodENMZW5ndGhcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gMSArIGNsX2hlYWRlciArIGNsX2RhdGE7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiVElHSFQgXCIgKyBjbW9kZSwgdGhpcy5fRkJVLmJ5dGVzKSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgICAgIC8vIFNoaWZ0IGN0bCwgY2xlbmd0aCBvZmZcbiAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcygxICsgY2xfaGVhZGVyKTtcblxuICAgICAgICAgICAgICAgIGlmIChyYXcpIHtcbiAgICAgICAgICAgICAgICAgICAgZGF0YSA9IHRoaXMuX3NvY2suclFzaGlmdEJ5dGVzKGNsX2RhdGEpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGRhdGEgPSBkZWNvbXByZXNzKHRoaXMuX3NvY2suclFzaGlmdEJ5dGVzKGNsX2RhdGEpLCB1bmNvbXByZXNzZWRTaXplKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmJsaXRSZ2JJbWFnZSh0aGlzLl9GQlUueCwgdGhpcy5fRkJVLnksIHRoaXMuX0ZCVS53aWR0aCwgdGhpcy5fRkJVLmhlaWdodCwgZGF0YSwgMCwgZmFsc2UpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9LmJpbmQodGhpcyk7XG5cbiAgICAgICAgICAgIHZhciBjdGwgPSB0aGlzLl9zb2NrLnJRcGVlazgoKTtcblxuICAgICAgICAgICAgLy8gS2VlcCB0aWdodCByZXNldCBiaXRzXG4gICAgICAgICAgICByZXNldFN0cmVhbXMgPSBjdGwgJiAweEY7XG5cbiAgICAgICAgICAgIC8vIEZpZ3VyZSBvdXQgZmlsdGVyXG4gICAgICAgICAgICBjdGwgPSBjdGwgPj4gNDtcbiAgICAgICAgICAgIHN0cmVhbUlkID0gY3RsICYgMHgzO1xuXG4gICAgICAgICAgICBpZiAoY3RsID09PSAweDA4KSAgICAgICBjbW9kZSA9IFwiZmlsbFwiO1xuICAgICAgICAgICAgZWxzZSBpZiAoY3RsID09PSAweDA5KSAgY21vZGUgPSBcImpwZWdcIjtcbiAgICAgICAgICAgIGVsc2UgaWYgKGN0bCA9PT0gMHgwQSkgIGNtb2RlID0gXCJwbmdcIjtcbiAgICAgICAgICAgIGVsc2UgaWYgKGN0bCAmIDB4MDQpICAgIGNtb2RlID0gXCJmaWx0ZXJcIjtcbiAgICAgICAgICAgIGVsc2UgaWYgKGN0bCA8IDB4MDQpICAgIGNtb2RlID0gXCJjb3B5XCI7XG4gICAgICAgICAgICBlbHNlIHJldHVybiB0aGlzLl9mYWlsKFwiSWxsZWdhbCB0aWdodCBjb21wcmVzc2lvbiByZWNlaXZlZCwgY3RsOiBcIiArIGN0bCk7XG5cbiAgICAgICAgICAgIGlmIChpc1RpZ2h0UE5HICYmIChjbW9kZSA9PT0gXCJmaWx0ZXJcIiB8fCBjbW9kZSA9PT0gXCJjb3B5XCIpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZhaWwoXCJmaWx0ZXIvY29weSByZWNlaXZlZCBpbiB0aWdodFBORyBtb2RlXCIpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBzd2l0Y2ggKGNtb2RlKSB7XG4gICAgICAgICAgICAgICAgLy8gZmlsbCB1c2UgZmJfZGVwdGggYmVjYXVzZSBUUElYRUxzIGRyb3AgdGhlIHBhZGRpbmcgYnl0ZVxuICAgICAgICAgICAgICAgIGNhc2UgXCJmaWxsXCI6ICAvLyBUUElYRUxcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzICs9IHRoaXMuX2ZiX2RlcHRoO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIFwianBlZ1wiOiAgLy8gbWF4IGNsZW5ndGhcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzICs9IDM7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgXCJwbmdcIjogIC8vIG1heCBjbGVuZ3RoXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX0ZCVS5ieXRlcyArPSAzO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICBjYXNlIFwiZmlsdGVyXCI6ICAvLyBmaWx0ZXIgaWQgKyBudW0gY29sb3JzIGlmIHBhbGV0dGVcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzICs9IDI7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgXCJjb3B5XCI6XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5fc29jay5yUXdhaXQoXCJUSUdIVCBcIiArIGNtb2RlLCB0aGlzLl9GQlUuYnl0ZXMpKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgICAgICAgICAvLyBEZXRlcm1pbmUgRkJVLmJ5dGVzXG4gICAgICAgICAgICBzd2l0Y2ggKGNtb2RlKSB7XG4gICAgICAgICAgICAgICAgY2FzZSBcImZpbGxcIjpcbiAgICAgICAgICAgICAgICAgICAgLy8gc2tpcCBjdGwgYnl0ZVxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmZpbGxSZWN0KHRoaXMuX0ZCVS54LCB0aGlzLl9GQlUueSwgdGhpcy5fRkJVLndpZHRoLCB0aGlzLl9GQlUuaGVpZ2h0LCBbclFbclFpICsgM10sIHJRW3JRaSArIDJdLCByUVtyUWkgKyAxXV0sIGZhbHNlKTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcyg0KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgY2FzZSBcInBuZ1wiOlxuICAgICAgICAgICAgICAgIGNhc2UgXCJqcGVnXCI6XG4gICAgICAgICAgICAgICAgICAgIC8vIGJlZ2luIGlubGluZSBnZXRUaWdodENMZW5ndGggKHJldHVybmluZyB0d28taXRlbSBhcnJheXMgaXMgZm9yIHBlZm9ybWFuY2Ugd2l0aCBHQylcbiAgICAgICAgICAgICAgICAgICAgdmFyIGNsX29mZnNldCA9IHJRaSArIDE7XG4gICAgICAgICAgICAgICAgICAgIGNsX2hlYWRlciA9IDE7XG4gICAgICAgICAgICAgICAgICAgIGNsX2RhdGEgPSAwO1xuICAgICAgICAgICAgICAgICAgICBjbF9kYXRhICs9IHJRW2NsX29mZnNldF0gJiAweDdmO1xuICAgICAgICAgICAgICAgICAgICBpZiAoclFbY2xfb2Zmc2V0XSAmIDB4ODApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNsX2hlYWRlcisrO1xuICAgICAgICAgICAgICAgICAgICAgICAgY2xfZGF0YSArPSAoclFbY2xfb2Zmc2V0ICsgMV0gJiAweDdmKSA8PCA3O1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHJRW2NsX29mZnNldCArIDFdICYgMHg4MCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsX2hlYWRlcisrO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsX2RhdGEgKz0gclFbY2xfb2Zmc2V0ICsgMl0gPDwgMTQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgLy8gZW5kIGlubGluZSBnZXRUaWdodENMZW5ndGhcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gMSArIGNsX2hlYWRlciArIGNsX2RhdGE7ICAvLyBjdGwgKyBjbGVuZ3RoIHNpemUgKyBqcGVnLWRhdGFcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3NvY2suclF3YWl0KFwiVElHSFQgXCIgKyBjbW9kZSwgdGhpcy5fRkJVLmJ5dGVzKSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgICAgICAgICAvLyBXZSBoYXZlIGV2ZXJ5dGhpbmcsIHJlbmRlciBpdFxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKDEgKyBjbF9oZWFkZXIpOyAgLy8gc2hpZnQgb2ZmIGNsdCArIGNvbXBhY3QgbGVuZ3RoXG4gICAgICAgICAgICAgICAgICAgIHZhciBpbWcgPSBuZXcgSW1hZ2UoKTtcbiAgICAgICAgICAgICAgICAgICAgaW1nLnNyYyA9IFwiZGF0YTogaW1hZ2UvXCIgKyBjbW9kZSArXG4gICAgICAgICAgICAgICAgICAgICAgICBSRkIuZXh0cmFjdF9kYXRhX3VyaSh0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyhjbF9kYXRhKSk7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkucmVuZGVyUV9wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgICAgICd0eXBlJzogJ2ltZycsXG4gICAgICAgICAgICAgICAgICAgICAgICAnaW1nJzogaW1nLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ3gnOiB0aGlzLl9GQlUueCxcbiAgICAgICAgICAgICAgICAgICAgICAgICd5JzogdGhpcy5fRkJVLnlcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIGltZyA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgXCJmaWx0ZXJcIjpcbiAgICAgICAgICAgICAgICAgICAgdmFyIGZpbHRlcklkID0gclFbclFpICsgMV07XG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWx0ZXJJZCA9PT0gMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFoYW5kbGVQYWxldHRlKCkpIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBGaWx0ZXIgMCwgQ29weSBjb3VsZCBiZSB2YWxpZCBoZXJlLCBidXQgc2VydmVycyBkb24ndCBzZW5kIGl0IGFzIGFuIGV4cGxpY2l0IGZpbHRlclxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gRmlsdGVyIDIsIEdyYWRpZW50IGlzIHZhbGlkIGJ1dCBub3QgdXNlIGlmIGpwZWcgaXMgZW5hYmxlZFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmFpbChcIlVuc3VwcG9ydGVkIHRpZ2h0IHN1YmVuY29kaW5nIHJlY2VpdmVkLCBmaWx0ZXI6IFwiICsgZmlsdGVySWQpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgXCJjb3B5XCI6XG4gICAgICAgICAgICAgICAgICAgIGlmICghaGFuZGxlQ29weSgpKSB7IHJldHVybiBmYWxzZTsgfVxuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuXG4gICAgICAgICAgICB0aGlzLl9GQlUuYnl0ZXMgPSAwO1xuICAgICAgICAgICAgdGhpcy5fRkJVLnJlY3RzLS07XG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIFRJR0hUOiBmdW5jdGlvbiAoKSB7IHJldHVybiB0aGlzLl9lbmNIYW5kbGVycy5kaXNwbGF5X3RpZ2h0KGZhbHNlKTsgfSxcbiAgICAgICAgVElHSFRfUE5HOiBmdW5jdGlvbiAoKSB7IHJldHVybiB0aGlzLl9lbmNIYW5kbGVycy5kaXNwbGF5X3RpZ2h0KHRydWUpOyB9LFxuXG4gICAgICAgIGxhc3RfcmVjdDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdGhpcy5fRkJVLnJlY3RzID0gMDtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIGhhbmRsZV9GQl9yZXNpemU6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHRoaXMuX2ZiX3dpZHRoID0gdGhpcy5fRkJVLndpZHRoO1xuICAgICAgICAgICAgdGhpcy5fZmJfaGVpZ2h0ID0gdGhpcy5fRkJVLmhlaWdodDtcbiAgICAgICAgICAgIHRoaXMuX2Rlc3RCdWZmID0gbmV3IFVpbnQ4QXJyYXkodGhpcy5fZmJfd2lkdGggKiB0aGlzLl9mYl9oZWlnaHQgKiA0KTtcbiAgICAgICAgICAgIHRoaXMuX2Rpc3BsYXkucmVzaXplKHRoaXMuX2ZiX3dpZHRoLCB0aGlzLl9mYl9oZWlnaHQpO1xuICAgICAgICAgICAgdGhpcy5fb25GQlJlc2l6ZSh0aGlzLCB0aGlzLl9mYl93aWR0aCwgdGhpcy5fZmJfaGVpZ2h0KTtcbiAgICAgICAgICAgIHRoaXMuX3RpbWluZy5mYnVfcnRfc3RhcnQgPSAobmV3IERhdGUoKSkuZ2V0VGltZSgpO1xuICAgICAgICAgICAgdGhpcy5fdXBkYXRlQ29udGludW91c1VwZGF0ZXMoKTtcblxuICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gMDtcbiAgICAgICAgICAgIHRoaXMuX0ZCVS5yZWN0cyAtPSAxO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgRXh0ZW5kZWREZXNrdG9wU2l6ZTogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gMTtcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIkV4dGVuZGVkRGVza3RvcFNpemVcIiwgdGhpcy5fRkJVLmJ5dGVzKSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgdGhpcy5fc3VwcG9ydHNTZXREZXNrdG9wU2l6ZSA9IHRydWU7XG4gICAgICAgICAgICB2YXIgbnVtYmVyX29mX3NjcmVlbnMgPSB0aGlzLl9zb2NrLnJRcGVlazgoKTtcblxuICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gNCArIChudW1iZXJfb2Zfc2NyZWVucyAqIDE2KTtcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcIkV4dGVuZGVkRGVza3RvcFNpemVcIiwgdGhpcy5fRkJVLmJ5dGVzKSkgeyByZXR1cm4gZmFsc2U7IH1cblxuICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygxKTsgIC8vIG51bWJlci1vZi1zY3JlZW5zXG4gICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKDMpOyAgLy8gcGFkZGluZ1xuXG4gICAgICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IG51bWJlcl9vZl9zY3JlZW5zOyBpICs9IDEpIHtcbiAgICAgICAgICAgICAgICAvLyBTYXZlIHRoZSBpZCBhbmQgZmxhZ3Mgb2YgdGhlIGZpcnN0IHNjcmVlblxuICAgICAgICAgICAgICAgIGlmIChpID09PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3NjcmVlbl9pZCA9IHRoaXMuX3NvY2suclFzaGlmdEJ5dGVzKDQpOyAgICAvLyBpZFxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKDIpOyAgICAgICAgICAgICAgICAgICAgICAgLy8geC1wb3NpdGlvblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKDIpOyAgICAgICAgICAgICAgICAgICAgICAgLy8geS1wb3NpdGlvblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKDIpOyAgICAgICAgICAgICAgICAgICAgICAgLy8gd2lkdGhcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNraXBCeXRlcygyKTsgICAgICAgICAgICAgICAgICAgICAgIC8vIGhlaWdodFxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9zY3JlZW5fZmxhZ3MgPSB0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyg0KTsgLy8gZmxhZ3NcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9zb2NrLnJRc2tpcEJ5dGVzKDE2KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qXG4gICAgICAgICAgICAgKiBUaGUgeC1wb3NpdGlvbiBpbmRpY2F0ZXMgdGhlIHJlYXNvbiBmb3IgdGhlIGNoYW5nZTpcbiAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgKiAgMCAtIHNlcnZlciByZXNpemVkIG9uIGl0cyBvd25cbiAgICAgICAgICAgICAqICAxIC0gdGhpcyBjbGllbnQgcmVxdWVzdGVkIHRoZSByZXNpemVcbiAgICAgICAgICAgICAqICAyIC0gYW5vdGhlciBjbGllbnQgcmVxdWVzdGVkIHRoZSByZXNpemVcbiAgICAgICAgICAgICAqL1xuXG4gICAgICAgICAgICAvLyBXZSBuZWVkIHRvIGhhbmRsZSBlcnJvcnMgd2hlbiB3ZSByZXF1ZXN0ZWQgdGhlIHJlc2l6ZS5cbiAgICAgICAgICAgIGlmICh0aGlzLl9GQlUueCA9PT0gMSAmJiB0aGlzLl9GQlUueSAhPT0gMCkge1xuICAgICAgICAgICAgICAgIHZhciBtc2cgPSBcIlwiO1xuICAgICAgICAgICAgICAgIC8vIFRoZSB5LXBvc2l0aW9uIGluZGljYXRlcyB0aGUgc3RhdHVzIGNvZGUgZnJvbSB0aGUgc2VydmVyXG4gICAgICAgICAgICAgICAgc3dpdGNoICh0aGlzLl9GQlUueSkge1xuICAgICAgICAgICAgICAgIGNhc2UgMTpcbiAgICAgICAgICAgICAgICAgICAgbXNnID0gXCJSZXNpemUgaXMgYWRtaW5pc3RyYXRpdmVseSBwcm9oaWJpdGVkXCI7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgMjpcbiAgICAgICAgICAgICAgICAgICAgbXNnID0gXCJPdXQgb2YgcmVzb3VyY2VzXCI7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIGNhc2UgMzpcbiAgICAgICAgICAgICAgICAgICAgbXNnID0gXCJJbnZhbGlkIHNjcmVlbiBsYXlvdXRcIjtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgbXNnID0gXCJVbmtub3duIHJlYXNvblwiO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiU2VydmVyIGRpZCBub3QgYWNjZXB0IHRoZSByZXNpemUgcmVxdWVzdDogXCIgKyBtc2cpO1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aGlzLl9lbmNIYW5kbGVycy5oYW5kbGVfRkJfcmVzaXplKCk7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuICAgICAgICBEZXNrdG9wU2l6ZTogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdGhpcy5fZW5jSGFuZGxlcnMuaGFuZGxlX0ZCX3Jlc2l6ZSgpO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgQ3Vyc29yOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBVdGlsLkRlYnVnKFwiPj4gc2V0X2N1cnNvclwiKTtcbiAgICAgICAgICAgIHZhciB4ID0gdGhpcy5fRkJVLng7ICAvLyBob3RzcG90LXhcbiAgICAgICAgICAgIHZhciB5ID0gdGhpcy5fRkJVLnk7ICAvLyBob3RzcG90LXlcbiAgICAgICAgICAgIHZhciB3ID0gdGhpcy5fRkJVLndpZHRoO1xuICAgICAgICAgICAgdmFyIGggPSB0aGlzLl9GQlUuaGVpZ2h0O1xuXG4gICAgICAgICAgICB2YXIgcGl4ZWxzbGVuZ3RoID0gdyAqIGggKiB0aGlzLl9mYl9CcHA7XG4gICAgICAgICAgICB2YXIgbWFza2xlbmd0aCA9IE1hdGguZmxvb3IoKHcgKyA3KSAvIDgpICogaDtcblxuICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gcGl4ZWxzbGVuZ3RoICsgbWFza2xlbmd0aDtcbiAgICAgICAgICAgIGlmICh0aGlzLl9zb2NrLnJRd2FpdChcImN1cnNvciBlbmNvZGluZ1wiLCB0aGlzLl9GQlUuYnl0ZXMpKSB7IHJldHVybiBmYWxzZTsgfVxuXG4gICAgICAgICAgICB0aGlzLl9kaXNwbGF5LmNoYW5nZUN1cnNvcih0aGlzLl9zb2NrLnJRc2hpZnRCeXRlcyhwaXhlbHNsZW5ndGgpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fc29jay5yUXNoaWZ0Qnl0ZXMobWFza2xlbmd0aCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB4LCB5LCB3LCBoKTtcblxuICAgICAgICAgICAgdGhpcy5fRkJVLmJ5dGVzID0gMDtcbiAgICAgICAgICAgIHRoaXMuX0ZCVS5yZWN0cy0tO1xuXG4gICAgICAgICAgICBVdGlsLkRlYnVnKFwiPDwgc2V0X2N1cnNvclwiKTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIFFFTVVFeHRlbmRlZEtleUV2ZW50OiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB0aGlzLl9GQlUucmVjdHMtLTtcblxuICAgICAgICAgICAgdmFyIGtleWJvYXJkRXZlbnQgPSBkb2N1bWVudC5jcmVhdGVFdmVudChcImtleWJvYXJkRXZlbnRcIik7XG4gICAgICAgICAgICBpZiAoa2V5Ym9hcmRFdmVudC5jb2RlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9xZW11RXh0S2V5RXZlbnRTdXBwb3J0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHRoaXMuX2tleWJvYXJkLnNldFFFTVVWTkNLZXlib2FyZEhhbmRsZXIoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBKUEVHX3F1YWxpdHlfbG86IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIFV0aWwuRXJyb3IoXCJTZXJ2ZXIgc2VudCBqcGVnX3F1YWxpdHkgcHNldWRvLWVuY29kaW5nXCIpO1xuICAgICAgICB9LFxuXG4gICAgICAgIGNvbXByZXNzX2xvOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBVdGlsLkVycm9yKFwiU2VydmVyIHNlbnQgY29tcHJlc3MgbGV2ZWwgcHNldWRvLWVuY29kaW5nXCIpO1xuICAgICAgICB9XG4gICAgfTtcbn0pKCk7XG4iXX0=