"use strict";

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.default = Websock;

var _util = require("./util");

var _util2 = _interopRequireDefault(_util);

var _base = require("./base64");

var _base2 = _interopRequireDefault(_base);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/*jslint browser: true, bitwise: true */
/*global Util*/

/*
 * Websock: high-performance binary WebSockets
 * Copyright (C) 2012 Joel Martin
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * Websock is similar to the standard WebSocket object but Websock
 * enables communication with raw TCP sockets (i.e. the binary stream)
 * via websockify. This is accomplished by base64 encoding the data
 * stream between Websock and websockify.
 *
 * Websock has built-in receive queue buffering; the message event
 * does not contain actual data but is simply a notification that
 * there is new data available. Several rQ* methods are available to
 * read binary data off of the receive queue.
 */

function Websock() {
    "use strict";

    this._websocket = null; // WebSocket object

    this._rQi = 0; // Receive queue index
    this._rQlen = 0; // Next write position in the receive queue
    this._rQbufferSize = 1024 * 1024 * 4; // Receive queue buffer size (4 MiB)
    this._rQmax = this._rQbufferSize / 8;
    // called in init: this._rQ = new Uint8Array(this._rQbufferSize);
    this._rQ = null; // Receive queue

    this._sQbufferSize = 1024 * 10; // 10 KiB
    // called in init: this._sQ = new Uint8Array(this._sQbufferSize);
    this._sQlen = 0;
    this._sQ = null; // Send queue

    this._mode = 'binary'; // Current WebSocket mode: 'binary', 'base64'
    this.maxBufferedAmount = 200;

    this._eventHandlers = {
        'message': function () {},
        'open': function () {},
        'close': function () {},
        'error': function () {}
    };
};

(function () {
    "use strict";
    // this has performance issues in some versions Chromium, and
    // doesn't gain a tremendous amount of performance increase in Firefox
    // at the moment.  It may be valuable to turn it on in the future.

    var ENABLE_COPYWITHIN = false;

    var MAX_RQ_GROW_SIZE = 40 * 1024 * 1024; // 40 MiB

    var typedArrayToString = function () {
        // This is only for PhantomJS, which doesn't like apply-ing
        // with Typed Arrays
        try {
            var arr = new Uint8Array([1, 2, 3]);
            String.fromCharCode.apply(null, arr);
            return function (a) {
                return String.fromCharCode.apply(null, a);
            };
        } catch (ex) {
            return function (a) {
                return String.fromCharCode.apply(null, Array.prototype.slice.call(a));
            };
        }
    }();

    Websock.prototype = {
        // Getters and Setters
        get_sQ: function () {
            return this._sQ;
        },

        get_rQ: function () {
            return this._rQ;
        },

        get_rQi: function () {
            return this._rQi;
        },

        set_rQi: function (val) {
            this._rQi = val;
        },

        // Receive Queue
        rQlen: function () {
            return this._rQlen - this._rQi;
        },

        rQpeek8: function () {
            return this._rQ[this._rQi];
        },

        rQshift8: function () {
            return this._rQ[this._rQi++];
        },

        rQskip8: function () {
            this._rQi++;
        },

        rQskipBytes: function (num) {
            this._rQi += num;
        },

        // TODO(directxman12): test performance with these vs a DataView
        rQshift16: function () {
            return (this._rQ[this._rQi++] << 8) + this._rQ[this._rQi++];
        },

        rQshift32: function () {
            return (this._rQ[this._rQi++] << 24) + (this._rQ[this._rQi++] << 16) + (this._rQ[this._rQi++] << 8) + this._rQ[this._rQi++];
        },

        rQshiftStr: function (len) {
            if (typeof len === 'undefined') {
                len = this.rQlen();
            }
            var arr = new Uint8Array(this._rQ.buffer, this._rQi, len);
            this._rQi += len;
            return typedArrayToString(arr);
        },

        rQshiftBytes: function (len) {
            if (typeof len === 'undefined') {
                len = this.rQlen();
            }
            this._rQi += len;
            return new Uint8Array(this._rQ.buffer, this._rQi - len, len);
        },

        rQshiftTo: function (target, len) {
            if (len === undefined) {
                len = this.rQlen();
            }
            // TODO: make this just use set with views when using a ArrayBuffer to store the rQ
            target.set(new Uint8Array(this._rQ.buffer, this._rQi, len));
            this._rQi += len;
        },

        rQwhole: function () {
            return new Uint8Array(this._rQ.buffer, 0, this._rQlen);
        },

        rQslice: function (start, end) {
            if (end) {
                return new Uint8Array(this._rQ.buffer, this._rQi + start, end - start);
            } else {
                return new Uint8Array(this._rQ.buffer, this._rQi + start, this._rQlen - this._rQi - start);
            }
        },

        // Check to see if we must wait for 'num' bytes (default to FBU.bytes)
        // to be available in the receive queue. Return true if we need to
        // wait (and possibly print a debug message), otherwise false.
        rQwait: function (msg, num, goback) {
            var rQlen = this._rQlen - this._rQi; // Skip rQlen() function call
            if (rQlen < num) {
                if (goback) {
                    if (this._rQi < goback) {
                        throw new Error("rQwait cannot backup " + goback + " bytes");
                    }
                    this._rQi -= goback;
                }
                return true; // true means need more data
            }
            return false;
        },

        // Send Queue

        flush: function () {
            if (this._websocket.bufferedAmount !== 0) {
                _util2.default.Debug("bufferedAmount: " + this._websocket.bufferedAmount);
            }

            if (this._websocket.bufferedAmount < this.maxBufferedAmount) {
                if (this._sQlen > 0 && this._websocket.readyState === WebSocket.OPEN) {
                    this._websocket.send(this._encode_message());
                    this._sQlen = 0;
                }

                return true;
            } else {
                _util2.default.Info("Delaying send, bufferedAmount: " + this._websocket.bufferedAmount);
                return false;
            }
        },

        send: function (arr) {
            this._sQ.set(arr, this._sQlen);
            this._sQlen += arr.length;
            return this.flush();
        },

        send_string: function (str) {
            this.send(str.split('').map(function (chr) {
                return chr.charCodeAt(0);
            }));
        },

        // Event Handlers
        off: function (evt) {
            this._eventHandlers[evt] = function () {};
        },

        on: function (evt, handler) {
            this._eventHandlers[evt] = handler;
        },

        _allocate_buffers: function () {
            this._rQ = new Uint8Array(this._rQbufferSize);
            this._sQ = new Uint8Array(this._sQbufferSize);
        },

        init: function (protocols, ws_schema) {
            this._allocate_buffers();
            this._rQi = 0;
            this._websocket = null;

            // Check for full typed array support
            var bt = false;
            if ('Uint8Array' in window && 'set' in Uint8Array.prototype) {
                bt = true;
            }

            // Check for full binary type support in WebSockets
            // Inspired by:
            // https://github.com/Modernizr/Modernizr/issues/370
            // https://github.com/Modernizr/Modernizr/blob/master/feature-detects/websockets/binary.js
            var wsbt = false;
            try {
                if (bt && ('binaryType' in WebSocket.prototype || !!new WebSocket(ws_schema + '://.').binaryType)) {
                    _util2.default.Info("Detected binaryType support in WebSockets");
                    wsbt = true;
                }
            } catch (exc) {}
            // Just ignore failed test localhost connection


            // Default protocols if not specified
            if (typeof protocols === "undefined") {
                protocols = 'binary';
            }

            if (Array.isArray(protocols) && protocols.indexOf('binary') > -1) {
                protocols = 'binary';
            }

            if (!wsbt) {
                throw new Error("noVNC no longer supports base64 WebSockets.  " + "Please use a browser which supports binary WebSockets.");
            }

            if (protocols != 'binary') {
                throw new Error("noVNC no longer supports base64 WebSockets.  Please " + "use the binary subprotocol instead.");
            }

            return protocols;
        },

        open: function (uri, protocols) {
            var ws_schema = uri.match(/^([a-z]+):\/\//)[1];
            protocols = this.init(protocols, ws_schema);

            this._websocket = new WebSocket(uri, protocols);

            if (protocols.indexOf('binary') >= 0) {
                this._websocket.binaryType = 'arraybuffer';
            }

            this._websocket.onmessage = this._recv_message.bind(this);
            this._websocket.onopen = function () {
                _util2.default.Debug('>> WebSock.onopen');
                if (this._websocket.protocol) {
                    this._mode = this._websocket.protocol;
                    _util2.default.Info("Server choose sub-protocol: " + this._websocket.protocol);
                } else {
                    this._mode = 'binary';
                    _util2.default.Error('Server select no sub-protocol!: ' + this._websocket.protocol);
                }

                if (this._mode != 'binary') {
                    throw new Error("noVNC no longer supports base64 WebSockets.  Please " + "use the binary subprotocol instead.");
                }

                this._eventHandlers.open();
                _util2.default.Debug("<< WebSock.onopen");
            }.bind(this);
            this._websocket.onclose = function (e) {
                _util2.default.Debug(">> WebSock.onclose");
                this._eventHandlers.close(e);
                _util2.default.Debug("<< WebSock.onclose");
            }.bind(this);
            this._websocket.onerror = function (e) {
                _util2.default.Debug(">> WebSock.onerror: " + e);
                this._eventHandlers.error(e);
                _util2.default.Debug("<< WebSock.onerror: " + e);
            }.bind(this);
        },

        close: function () {
            if (this._websocket) {
                if (this._websocket.readyState === WebSocket.OPEN || this._websocket.readyState === WebSocket.CONNECTING) {
                    _util2.default.Info("Closing WebSocket connection");
                    this._websocket.close();
                }

                this._websocket.onmessage = function (e) {
                    return;
                };
            }
        },

        // private methods
        _encode_message: function () {
            // Put in a binary arraybuffer
            // according to the spec, you can send ArrayBufferViews with the send method
            return new Uint8Array(this._sQ.buffer, 0, this._sQlen);
        },

        _expand_compact_rQ: function (min_fit) {
            var resizeNeeded = min_fit || this._rQlen - this._rQi > this._rQbufferSize / 2;
            if (resizeNeeded) {
                if (!min_fit) {
                    // just double the size if we need to do compaction
                    this._rQbufferSize *= 2;
                } else {
                    // otherwise, make sure we satisy rQlen - rQi + min_fit < rQbufferSize / 8
                    this._rQbufferSize = (this._rQlen - this._rQi + min_fit) * 8;
                }
            }

            // we don't want to grow unboundedly
            if (this._rQbufferSize > MAX_RQ_GROW_SIZE) {
                this._rQbufferSize = MAX_RQ_GROW_SIZE;
                if (this._rQbufferSize - this._rQlen - this._rQi < min_fit) {
                    throw new Exception("Receive Queue buffer exceeded " + MAX_RQ_GROW_SIZE + " bytes, and the new message could not fit");
                }
            }

            if (resizeNeeded) {
                var old_rQbuffer = this._rQ.buffer;
                this._rQmax = this._rQbufferSize / 8;
                this._rQ = new Uint8Array(this._rQbufferSize);
                this._rQ.set(new Uint8Array(old_rQbuffer, this._rQi));
            } else {
                if (ENABLE_COPYWITHIN) {
                    this._rQ.copyWithin(0, this._rQi);
                } else {
                    this._rQ.set(new Uint8Array(this._rQ.buffer, this._rQi));
                }
            }

            this._rQlen = this._rQlen - this._rQi;
            this._rQi = 0;
        },

        _decode_message: function (data) {
            // push arraybuffer values onto the end
            var u8 = new Uint8Array(data);
            if (u8.length > this._rQbufferSize - this._rQlen) {
                this._expand_compact_rQ(u8.length);
            }
            this._rQ.set(u8, this._rQlen);
            this._rQlen += u8.length;
        },

        _recv_message: function (e) {
            try {
                this._decode_message(e.data);
                if (this.rQlen() > 0) {
                    this._eventHandlers.message();
                    // Compact the receive queue
                    if (this._rQlen == this._rQi) {
                        this._rQlen = 0;
                        this._rQi = 0;
                    } else if (this._rQlen > this._rQmax) {
                        this._expand_compact_rQ();
                    }
                } else {
                    _util2.default.Debug("Ignoring empty message");
                }
            } catch (exc) {
                var exception_str = "";
                if (exc.name) {
                    exception_str += "\n    name: " + exc.name + "\n";
                    exception_str += "    message: " + exc.message + "\n";
                }

                if (typeof exc.description !== 'undefined') {
                    exception_str += "    description: " + exc.description + "\n";
                }

                if (typeof exc.stack !== 'undefined') {
                    exception_str += exc.stack;
                }

                if (exception_str.length > 0) {
                    _util2.default.Error("recv_message, caught exception: " + exception_str);
                } else {
                    _util2.default.Error("recv_message, caught exception: " + exc);
                }

                if (typeof exc.name !== 'undefined') {
                    this._eventHandlers.error(exc.name + ": " + exc.message);
                } else {
                    this._eventHandlers.error(exc);
                }
            }
        }
    };
})();
module.exports = exports["default"];
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIndlYnNvY2suanMiXSwibmFtZXMiOlsiV2Vic29jayIsIl93ZWJzb2NrZXQiLCJfclFpIiwiX3JRbGVuIiwiX3JRYnVmZmVyU2l6ZSIsIl9yUW1heCIsIl9yUSIsIl9zUWJ1ZmZlclNpemUiLCJfc1FsZW4iLCJfc1EiLCJfbW9kZSIsIm1heEJ1ZmZlcmVkQW1vdW50IiwiX2V2ZW50SGFuZGxlcnMiLCJFTkFCTEVfQ09QWVdJVEhJTiIsIk1BWF9SUV9HUk9XX1NJWkUiLCJ0eXBlZEFycmF5VG9TdHJpbmciLCJhcnIiLCJVaW50OEFycmF5IiwiU3RyaW5nIiwiZnJvbUNoYXJDb2RlIiwiYXBwbHkiLCJhIiwiZXgiLCJBcnJheSIsInByb3RvdHlwZSIsInNsaWNlIiwiY2FsbCIsImdldF9zUSIsImdldF9yUSIsImdldF9yUWkiLCJzZXRfclFpIiwidmFsIiwiclFsZW4iLCJyUXBlZWs4IiwiclFzaGlmdDgiLCJyUXNraXA4IiwiclFza2lwQnl0ZXMiLCJudW0iLCJyUXNoaWZ0MTYiLCJyUXNoaWZ0MzIiLCJyUXNoaWZ0U3RyIiwibGVuIiwiYnVmZmVyIiwiclFzaGlmdEJ5dGVzIiwiclFzaGlmdFRvIiwidGFyZ2V0IiwidW5kZWZpbmVkIiwic2V0IiwiclF3aG9sZSIsInJRc2xpY2UiLCJzdGFydCIsImVuZCIsInJRd2FpdCIsIm1zZyIsImdvYmFjayIsIkVycm9yIiwiZmx1c2giLCJidWZmZXJlZEFtb3VudCIsIkRlYnVnIiwicmVhZHlTdGF0ZSIsIldlYlNvY2tldCIsIk9QRU4iLCJzZW5kIiwiX2VuY29kZV9tZXNzYWdlIiwiSW5mbyIsImxlbmd0aCIsInNlbmRfc3RyaW5nIiwic3RyIiwic3BsaXQiLCJtYXAiLCJjaHIiLCJjaGFyQ29kZUF0Iiwib2ZmIiwiZXZ0Iiwib24iLCJoYW5kbGVyIiwiX2FsbG9jYXRlX2J1ZmZlcnMiLCJpbml0IiwicHJvdG9jb2xzIiwid3Nfc2NoZW1hIiwiYnQiLCJ3aW5kb3ciLCJ3c2J0IiwiYmluYXJ5VHlwZSIsImV4YyIsImlzQXJyYXkiLCJpbmRleE9mIiwib3BlbiIsInVyaSIsIm1hdGNoIiwib25tZXNzYWdlIiwiX3JlY3ZfbWVzc2FnZSIsImJpbmQiLCJvbm9wZW4iLCJwcm90b2NvbCIsIm9uY2xvc2UiLCJlIiwiY2xvc2UiLCJvbmVycm9yIiwiZXJyb3IiLCJDT05ORUNUSU5HIiwiX2V4cGFuZF9jb21wYWN0X3JRIiwibWluX2ZpdCIsInJlc2l6ZU5lZWRlZCIsIkV4Y2VwdGlvbiIsIm9sZF9yUWJ1ZmZlciIsImNvcHlXaXRoaW4iLCJfZGVjb2RlX21lc3NhZ2UiLCJkYXRhIiwidTgiLCJtZXNzYWdlIiwiZXhjZXB0aW9uX3N0ciIsIm5hbWUiLCJkZXNjcmlwdGlvbiIsInN0YWNrIl0sIm1hcHBpbmdzIjoiOzs7OztrQkF1QndCQSxPOztBQVB4Qjs7OztBQUNBOzs7Ozs7QUFHQTtBQUNBOztBQXJCQTs7Ozs7Ozs7Ozs7Ozs7OztBQXVCZSxTQUFTQSxPQUFULEdBQW1CO0FBQzlCOztBQUVBLFNBQUtDLFVBQUwsR0FBa0IsSUFBbEIsQ0FIOEIsQ0FHTDs7QUFFekIsU0FBS0MsSUFBTCxHQUFZLENBQVosQ0FMOEIsQ0FLTDtBQUN6QixTQUFLQyxNQUFMLEdBQWMsQ0FBZCxDQU44QixDQU1MO0FBQ3pCLFNBQUtDLGFBQUwsR0FBcUIsT0FBTyxJQUFQLEdBQWMsQ0FBbkMsQ0FQOEIsQ0FPUTtBQUN0QyxTQUFLQyxNQUFMLEdBQWMsS0FBS0QsYUFBTCxHQUFxQixDQUFuQztBQUNBO0FBQ0EsU0FBS0UsR0FBTCxHQUFXLElBQVgsQ0FWOEIsQ0FVYjs7QUFFakIsU0FBS0MsYUFBTCxHQUFxQixPQUFPLEVBQTVCLENBWjhCLENBWUc7QUFDakM7QUFDQSxTQUFLQyxNQUFMLEdBQWMsQ0FBZDtBQUNBLFNBQUtDLEdBQUwsR0FBVyxJQUFYLENBZjhCLENBZVo7O0FBRWxCLFNBQUtDLEtBQUwsR0FBYSxRQUFiLENBakI4QixDQWlCSjtBQUMxQixTQUFLQyxpQkFBTCxHQUF5QixHQUF6Qjs7QUFFQSxTQUFLQyxjQUFMLEdBQXNCO0FB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QUFYO0FBQ0g7QUFDSixhQWRELENBY0UsT0FBTzBCLEdBQVAsRUFBWTtBQUNWLG9CQUFJMkIsZ0JBQWdCLEVBQXBCO0FBQ0Esb0JBQUkzQixJQUFJNEIsSUFBUixFQUFjO0FBQ1ZELHFDQUFpQixpQkFBaUIzQixJQUFJNEIsSUFBckIsR0FBNEIsSUFBN0M7QUFDQUQscUNBQWlCLGtCQUFrQjNCLElBQUkwQixPQUF0QixHQUFnQyxJQUFqRDtBQUNIOztBQUVELG9CQUFJLE9BQU8xQixJQUFJNkIsV0FBWCxLQUEyQixXQUEvQixFQUE0QztBQUN4Q0YscUNBQWlCLHNCQUFzQjNCLElBQUk2QixXQUExQixHQUF3QyxJQUF6RDtBQUNIOztBQUVELG9CQUFJLE9BQU83QixJQUFJOEIsS0FBWCxLQUFxQixXQUF6QixFQUFzQztBQUNsQ0gscUNBQWlCM0IsSUFBSThCLEtBQXJCO0FBQ0g7O0FBRUQsb0JBQUlILGNBQWM5QyxNQUFkLEdBQXVCLENBQTNCLEVBQThCO0FBQzFCLG1DQUFLVixLQUFMLENBQVcscUNBQXFDd0QsYUFBaEQ7QUFDSCxpQkFGRCxNQUVPO0FBQ0gsbUNBQUt4RCxLQUFMLENBQVcscUNBQXFDNkIsR0FBaEQ7QUFDSDs7QUFFRCxvQkFBSSxPQUFPQSxJQUFJNEIsSUFBWCxLQUFvQixXQUF4QixFQUFxQztBQUNqQyx5QkFBS3BHLGNBQUwsQ0FBb0J1RixLQUFwQixDQUEwQmYsSUFBSTRCLElBQUosR0FBVyxJQUFYLEdBQWtCNUIsSUFBSTBCLE9BQWhEO0FBQ0gsaUJBRkQsTUFFTztBQUNILHlCQUFLbEcsY0FBTCxDQUFvQnVGLEtBQXBCLENBQTBCZixHQUExQjtBQUNIO0FBQ0o7QUFDSjtBQTNWZSxLQUFwQjtBQTZWSCxDQXJYRCIsImZpbGUiOiJ3ZWJzb2NrLmpzIiwic291cmNlc0NvbnRlbnQiOlsiLypcbiAqIFdlYnNvY2s6IGhpZ2gtcGVyZm9ybWFuY2UgYmluYXJ5IFdlYlNvY2tldHNcbiAqIENvcHlyaWdodCAoQykgMjAxMiBKb2VsIE1hcnRpblxuICogTGljZW5zZWQgdW5kZXIgTVBMIDIuMCAoc2VlIExJQ0VOU0UudHh0KVxuICpcbiAqIFdlYnNvY2sgaXMgc2ltaWxhciB0byB0aGUgc3RhbmRhcmQgV2ViU29ja2V0IG9iamVjdCBidXQgV2Vic29ja1xuICogZW5hYmxlcyBjb21tdW5pY2F0aW9uIHdpdGggcmF3IFRDUCBzb2NrZXRzIChpLmUuIHRoZSBiaW5hcnkgc3RyZWFtKVxuICogdmlhIHdlYnNvY2tpZnkuIFRoaXMgaXMgYWNjb21wbGlzaGVkIGJ5IGJhc2U2NCBlbmNvZGluZyB0aGUgZGF0YVxuICogc3RyZWFtIGJldHdlZW4gV2Vic29jayBhbmQgd2Vic29ja2lmeS5cbiAqXG4gKiBXZWJzb2NrIGhhcyBidWlsdC1pbiByZWNlaXZlIHF1ZXVlIGJ1ZmZlcmluZzsgdGhlIG1lc3NhZ2UgZXZlbnRcbiAqIGRvZXMgbm90IGNvbnRhaW4gYWN0dWFsIGRhdGEgYnV0IGlzIHNpbXBseSBhIG5vdGlmaWNhdGlvbiB0aGF0XG4gKiB0aGVyZSBpcyBuZXcgZGF0YSBhdmFpbGFibGUuIFNldmVyYWwgclEqIG1ldGhvZHMgYXJlIGF2YWlsYWJsZSB0b1xuICogcmVhZCBiaW5hcnkgZGF0YSBvZmYgb2YgdGhlIHJlY2VpdmUgcXVldWUuXG4gKi9cblxuaW1wb3J0IFV0aWwgZnJvbSBcIi4vdXRpbFwiO1xuaW1wb3J0IEJhc2U2NCBmcm9tIFwiLi9iYXNlNjRcIjtcblxuXG4vKmpzbGludCBicm93c2VyOiB0cnVlLCBiaXR3aXNlOiB0cnVlICovXG4vKmdsb2JhbCBVdGlsKi9cblxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gV2Vic29jaygpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcblxuICAgIHRoaXMuX3dlYnNvY2tldCA9IG51bGw7ICAvLyBXZWJTb2NrZXQgb2JqZWN0XG5cbiAgICB0aGlzLl9yUWkgPSAwOyAgICAgICAgICAgLy8gUmVjZWl2ZSBxdWV1ZSBpbmRleFxuICAgIHRoaXMuX3JRbGVuID0gMDsgICAgICAgICAvLyBOZXh0IHdyaXRlIHBvc2l0aW9uIGluIHRoZSByZWNlaXZlIHF1ZXVlXG4gICAgdGhpcy5fclFidWZmZXJTaXplID0gMTAyNCAqIDEwMjQgKiA0OyAvLyBSZWNlaXZlIHF1ZXVlIGJ1ZmZlciBzaXplICg0IE1pQilcbiAgICB0aGlzLl9yUW1heCA9IHRoaXMuX3JRYnVmZmVyU2l6ZSAvIDg7XG4gICAgLy8gY2FsbGVkIGluIGluaXQ6IHRoaXMuX3JRID0gbmV3IFVpbnQ4QXJyYXkodGhpcy5fclFidWZmZXJTaXplKTtcbiAgICB0aGlzLl9yUSA9IG51bGw7IC8vIFJlY2VpdmUgcXVldWVcblxuICAgIHRoaXMuX3NRYnVmZmVyU2l6ZSA9IDEwMjQgKiAxMDsgIC8vIDEwIEtpQlxuICAgIC8vIGNhbGxlZCBpbiBpbml0OiB0aGlzLl9zUSA9IG5ldyBVaW50OEFycmF5KHRoaXMuX3NRYnVmZmVyU2l6ZSk7XG4gICAgdGhpcy5fc1FsZW4gPSAwO1xuICAgIHRoaXMuX3NRID0gbnVsbDsgIC8vIFNlbmQgcXVldWVcblxuICAgIHRoaXMuX21vZGUgPSAnYmluYXJ5JzsgICAgLy8gQ3VycmVudCBXZWJTb2NrZXQgbW9kZTogJ2JpbmFyeScsICdiYXNlNjQnXG4gICAgdGhpcy5tYXhCdWZmZXJlZEFtb3VudCA9IDIwMDtcblxuICAgIHRoaXMuX2V2ZW50SGFuZGxlcnMgPSB7XG4gICAgICAgICdtZXNzYWdlJzogZnVuY3Rpb24gKCkge30sXG4gICAgICAgICdvcGVuJzogZnVuY3Rpb24gKCkge30sXG4gICAgICAgICdjbG9zZSc6IGZ1bmN0aW9uICgpIHt9LFxuICAgICAgICAnZXJyb3InOiBmdW5jdGlvbiAoKSB7fVxuICAgIH07XG59O1xuXG4oZnVuY3Rpb24gKCkge1xuICAgIFwidXNlIHN0cmljdFwiO1xuICAgIC8vIHRoaXMgaGFzIHBlcmZvcm1hbmNlIGlzc3VlcyBpbiBzb21lIHZlcnNpb25zIENocm9taXVtLCBhbmRcbiAgICAvLyBkb2Vzbid0IGdhaW4gYSB0cmVtZW5kb3VzIGFtb3VudCBvZiBwZXJmb3JtYW5jZSBpbmNyZWFzZSBpbiBGaXJlZm94XG4gICAgLy8gYXQgdGhlIG1vbWVudC4gIEl0IG1heSBiZSB2YWx1YWJsZSB0byB0dXJuIGl0IG9uIGluIHRoZSBmdXR1cmUuXG4gICAgdmFyIEVOQUJMRV9DT1BZV0lUSElOID0gZmFsc2U7XG5cbiAgICB2YXIgTUFYX1JRX0dST1dfU0laRSA9IDQwICogMTAyNCAqIDEwMjQ7ICAvLyA0MCBNaUJcblxuICAgIHZhciB0eXBlZEFycmF5VG9TdHJpbmcgPSAoZnVuY3Rpb24gKCkge1xuICAgICAgICAvLyBUaGlzIGlzIG9ubHkgZm9yIFBoYW50b21KUywgd2hpY2ggZG9lc24ndCBsaWtlIGFwcGx5LWluZ1xuICAgICAgICAvLyB3aXRoIFR5cGVkIEFycmF5c1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgdmFyIGFyciA9IG5ldyBVaW50OEFycmF5KFsxLCAyLCAzXSk7XG4gICAgICAgICAgICBTdHJpbmcuZnJvbUNoYXJDb2RlLmFwcGx5KG51bGwsIGFycik7XG4gICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKGEpIHsgcmV0dXJuIFN0cmluZy5mcm9tQ2hhckNvZGUuYXBwbHkobnVsbCwgYSk7IH07XG4gICAgICAgIH0gY2F0Y2ggKGV4KSB7XG4gICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKGEpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gU3RyaW5nLmZyb21DaGFyQ29kZS5hcHBseShcbiAgICAgICAgICAgICAgICAgICAgbnVsbCwgQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYSkpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgIH0pKCk7XG5cbiAgICBXZWJzb2NrLnByb3RvdHlwZSA9IHtcbiAgICAgICAgLy8gR2V0dGVycyBhbmQgU2V0dGVyc1xuICAgICAgICBnZXRfc1E6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9zUTtcbiAgICAgICAgfSxcblxuICAgICAgICBnZXRfclE6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9yUTtcbiAgICAgICAgfSxcblxuICAgICAgICBnZXRfclFpOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fclFpO1xuICAgICAgICB9LFxuXG4gICAgICAgIHNldF9yUWk6IGZ1bmN0aW9uICh2YWwpIHtcbiAgICAgICAgICAgIHRoaXMuX3JRaSA9IHZhbDtcbiAgICAgICAgfSxcblxuICAgICAgICAvLyBSZWNlaXZlIFF1ZXVlXG4gICAgICAgIHJRbGVuOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fclFsZW4gLSB0aGlzLl9yUWk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgclFwZWVrODogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3JRW3RoaXMuX3JRaV07XG4gICAgICAgIH0sXG5cbiAgICAgICAgclFzaGlmdDg6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9yUVt0aGlzLl9yUWkrK107XG4gICAgICAgIH0sXG5cbiAgICAgICAgclFza2lwODogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdGhpcy5fclFpKys7XG4gICAgICAgIH0sXG5cbiAgICAgICAgclFza2lwQnl0ZXM6IGZ1bmN0aW9uIChudW0pIHtcbiAgICAgICAgICAgIHRoaXMuX3JRaSArPSBudW07XG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gVE9ETyhkaXJlY3R4bWFuMTIpOiB0ZXN0IHBlcmZvcm1hbmNlIHdpdGggdGhlc2UgdnMgYSBEYXRhVmlld1xuICAgICAgICByUXNoaWZ0MTY6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHJldHVybiAodGhpcy5fclFbdGhpcy5fclFpKytdIDw8IDgpICtcbiAgICAgICAgICAgICAgICAgICB0aGlzLl9yUVt0aGlzLl9yUWkrK107XG4gICAgICAgIH0sXG5cbiAgICAgICAgclFzaGlmdDMyOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gKHRoaXMuX3JRW3RoaXMuX3JRaSsrXSA8PCAyNCkgK1xuICAgICAgICAgICAgICAgICAgICh0aGlzLl9yUVt0aGlzLl9yUWkrK10gPDwgMTYpICtcbiAgICAgICAgICAgICAgICAgICAodGhpcy5fclFbdGhpcy5fclFpKytdIDw8IDgpICtcbiAgICAgICAgICAgICAgICAgICB0aGlzLl9yUVt0aGlzLl9yUWkrK107XG4gICAgICAgIH0sXG5cbiAgICAgICAgclFzaGlmdFN0cjogZnVuY3Rpb24gKGxlbikge1xuICAgICAgICAgICAgaWYgKHR5cGVvZihsZW4pID09PSAndW5kZWZpbmVkJykgeyBsZW4gPSB0aGlzLnJRbGVuKCk7IH1cbiAgICAgICAgICAgIHZhciBhcnIgPSBuZXcgVWludDhBcnJheSh0aGlzLl9yUS5idWZmZXIsIHRoaXMuX3JRaSwgbGVuKTtcbiAgICAgICAgICAgIHRoaXMuX3JRaSArPSBsZW47XG4gICAgICAgICAgICByZXR1cm4gdHlwZWRBcnJheVRvU3RyaW5nKGFycik7XG4gICAgICAgIH0sXG5cbiAgICAgICAgclFzaGlmdEJ5dGVzOiBmdW5jdGlvbiAobGVuKSB7XG4gICAgICAgICAgICBpZiAodHlwZW9mKGxlbikgPT09ICd1bmRlZmluZWQnKSB7IGxlbiA9IHRoaXMuclFsZW4oKTsgfVxuICAgICAgICAgICAgdGhpcy5fclFpICs9IGxlbjtcbiAgICAgICAgICAgIHJldHVybiBuZXcgVWludDhBcnJheSh0aGlzLl9yUS5idWZmZXIsIHRoaXMuX3JRaSAtIGxlbiwgbGVuKTtcbiAgICAgICAgfSxcblxuICAgICAgICByUXNoaWZ0VG86IGZ1bmN0aW9uICh0YXJnZXQsIGxlbikge1xuICAgICAgICAgICAgaWYgKGxlbiA9PT0gdW5kZWZpbmVkKSB7IGxlbiA9IHRoaXMuclFsZW4oKTsgfVxuICAgICAgICAgICAgLy8gVE9ETzogbWFrZSB0aGlzIGp1c3QgdXNlIHNldCB3aXRoIHZpZXdzIHdoZW4gdXNpbmcgYSBBcnJheUJ1ZmZlciB0byBzdG9yZSB0aGUgclFcbiAgICAgICAgICAgIHRhcmdldC5zZXQobmV3IFVpbnQ4QXJyYXkodGhpcy5fclEuYnVmZmVyLCB0aGlzLl9yUWksIGxlbikpO1xuICAgICAgICAgICAgdGhpcy5fclFpICs9IGxlbjtcbiAgICAgICAgfSxcblxuICAgICAgICByUXdob2xlOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkodGhpcy5fclEuYnVmZmVyLCAwLCB0aGlzLl9yUWxlbik7XG4gICAgICAgIH0sXG5cbiAgICAgICAgclFzbGljZTogZnVuY3Rpb24gKHN0YXJ0LCBlbmQpIHtcbiAgICAgICAgICAgIGlmIChlbmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkodGhpcy5fclEuYnVmZmVyLCB0aGlzLl9yUWkgKyBzdGFydCwgZW5kIC0gc3RhcnQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkodGhpcy5fclEuYnVmZmVyLCB0aGlzLl9yUWkgKyBzdGFydCwgdGhpcy5fclFsZW4gLSB0aGlzLl9yUWkgLSBzdGFydCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gQ2hlY2sgdG8gc2VlIGlmIHdlIG11c3Qgd2FpdCBmb3IgJ251bScgYnl0ZXMgKGRlZmF1bHQgdG8gRkJVLmJ5dGVzKVxuICAgICAgICAvLyB0byBiZSBhdmFpbGFibGUgaW4gdGhlIHJlY2VpdmUgcXVldWUuIFJldHVybiB0cnVlIGlmIHdlIG5lZWQgdG9cbiAgICAgICAgLy8gd2FpdCAoYW5kIHBvc3NpYmx5IHByaW50IGEgZGVidWcgbWVzc2FnZSksIG90aGVyd2lzZSBmYWxzZS5cbiAgICAgICAgclF3YWl0OiBmdW5jdGlvbiAobXNnLCBudW0sIGdvYmFjaykge1xuICAgICAgICAgICAgdmFyIHJRbGVuID0gdGhpcy5fclFsZW4gLSB0aGlzLl9yUWk7IC8vIFNraXAgclFsZW4oKSBmdW5jdGlvbiBjYWxsXG4gICAgICAgICAgICBpZiAoclFsZW4gPCBudW0pIHtcbiAgICAgICAgICAgICAgICBpZiAoZ29iYWNrKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9yUWkgPCBnb2JhY2spIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcInJRd2FpdCBjYW5ub3QgYmFja3VwIFwiICsgZ29iYWNrICsgXCIgYnl0ZXNcIik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fclFpIC09IGdvYmFjaztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7IC8vIHRydWUgbWVhbnMgbmVlZCBtb3JlIGRhdGFcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfSxcblxuICAgICAgICAvLyBTZW5kIFF1ZXVlXG5cbiAgICAgICAgZmx1c2g6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl93ZWJzb2NrZXQuYnVmZmVyZWRBbW91bnQgIT09IDApIHtcbiAgICAgICAgICAgICAgICBVdGlsLkRlYnVnKFwiYnVmZmVyZWRBbW91bnQ6IFwiICsgdGhpcy5fd2Vic29ja2V0LmJ1ZmZlcmVkQW1vdW50KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX3dlYnNvY2tldC5idWZmZXJlZEFtb3VudCA8IHRoaXMubWF4QnVmZmVyZWRBbW91bnQpIHtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fc1FsZW4gPiAwICYmIHRoaXMuX3dlYnNvY2tldC5yZWFkeVN0YXRlID09PSBXZWJTb2NrZXQuT1BFTikge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl93ZWJzb2NrZXQuc2VuZCh0aGlzLl9lbmNvZGVfbWVzc2FnZSgpKTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fc1FsZW4gPSAwO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBVdGlsLkluZm8oXCJEZWxheWluZyBzZW5kLCBidWZmZXJlZEFtb3VudDogXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fd2Vic29ja2V0LmJ1ZmZlcmVkQW1vdW50KTtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgc2VuZDogZnVuY3Rpb24gKGFycikge1xuICAgICAgICAgICAgdGhpcy5fc1Euc2V0KGFyciwgdGhpcy5fc1FsZW4pO1xuICAgICAgICAgICAgdGhpcy5fc1FsZW4gKz0gYXJyLmxlbmd0aDtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmZsdXNoKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgc2VuZF9zdHJpbmc6IGZ1bmN0aW9uIChzdHIpIHtcbiAgICAgICAgICAgIHRoaXMuc2VuZChzdHIuc3BsaXQoJycpLm1hcChmdW5jdGlvbiAoY2hyKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNoci5jaGFyQ29kZUF0KDApO1xuICAgICAgICAgICAgfSkpO1xuICAgICAgICB9LFxuXG4gICAgICAgIC8vIEV2ZW50IEhhbmRsZXJzXG4gICAgICAgIG9mZjogZnVuY3Rpb24gKGV2dCkge1xuICAgICAgICAgICAgdGhpcy5fZXZlbnRIYW5kbGVyc1tldnRdID0gZnVuY3Rpb24gKCkge307XG4gICAgICAgIH0sXG5cbiAgICAgICAgb246IGZ1bmN0aW9uIChldnQsIGhhbmRsZXIpIHtcbiAgICAgICAgICAgIHRoaXMuX2V2ZW50SGFuZGxlcnNbZXZ0XSA9IGhhbmRsZXI7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2FsbG9jYXRlX2J1ZmZlcnM6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHRoaXMuX3JRID0gbmV3IFVpbnQ4QXJyYXkodGhpcy5fclFidWZmZXJTaXplKTtcbiAgICAgICAgICAgIHRoaXMuX3NRID0gbmV3IFVpbnQ4QXJyYXkodGhpcy5fc1FidWZmZXJTaXplKTtcbiAgICAgICAgfSxcblxuICAgICAgICBpbml0OiBmdW5jdGlvbiAocHJvdG9jb2xzLCB3c19zY2hlbWEpIHtcbiAgICAgICAgICAgIHRoaXMuX2FsbG9jYXRlX2J1ZmZlcnMoKTtcbiAgICAgICAgICAgIHRoaXMuX3JRaSA9IDA7XG4gICAgICAgICAgICB0aGlzLl93ZWJzb2NrZXQgPSBudWxsO1xuXG4gICAgICAgICAgICAvLyBDaGVjayBmb3IgZnVsbCB0eXBlZCBhcnJheSBzdXBwb3J0XG4gICAgICAgICAgICB2YXIgYnQgPSBmYWxzZTtcbiAgICAgICAgICAgIGlmICgoJ1VpbnQ4QXJyYXknIGluIHdpbmRvdykgJiZcbiAgICAgICAgICAgICAgICAgICAgKCdzZXQnIGluIFVpbnQ4QXJyYXkucHJvdG90eXBlKSkge1xuICAgICAgICAgICAgICAgIGJ0ID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gQ2hlY2sgZm9yIGZ1bGwgYmluYXJ5IHR5cGUgc3VwcG9ydCBpbiBXZWJTb2NrZXRzXG4gICAgICAgICAgICAvLyBJbnNwaXJlZCBieTpcbiAgICAgICAgICAgIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9Nb2Rlcm5penIvTW9kZXJuaXpyL2lzc3Vlcy8zNzBcbiAgICAgICAgICAgIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9Nb2Rlcm5penIvTW9kZXJuaXpyL2Jsb2IvbWFzdGVyL2ZlYXR1cmUtZGV0ZWN0cy93ZWJzb2NrZXRzL2JpbmFyeS5qc1xuICAgICAgICAgICAgdmFyIHdzYnQgPSBmYWxzZTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgaWYgKGJ0ICYmICgnYmluYXJ5VHlwZScgaW4gV2ViU29ja2V0LnByb3RvdHlwZSB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgISEobmV3IFdlYlNvY2tldCh3c19zY2hlbWEgKyAnOi8vLicpLmJpbmFyeVR5cGUpKSkge1xuICAgICAgICAgICAgICAgICAgICBVdGlsLkluZm8oXCJEZXRlY3RlZCBiaW5hcnlUeXBlIHN1cHBvcnQgaW4gV2ViU29ja2V0c1wiKTtcbiAgICAgICAgICAgICAgICAgICAgd3NidCA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCAoZXhjKSB7XG4gICAgICAgICAgICAgICAgLy8gSnVzdCBpZ25vcmUgZmFpbGVkIHRlc3QgbG9jYWxob3N0IGNvbm5lY3Rpb25cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gRGVmYXVsdCBwcm90b2NvbHMgaWYgbm90IHNwZWNpZmllZFxuICAgICAgICAgICAgaWYgKHR5cGVvZihwcm90b2NvbHMpID09PSBcInVuZGVmaW5lZFwiKSB7XG4gICAgICAgICAgICAgICAgcHJvdG9jb2xzID0gJ2JpbmFyeSc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHByb3RvY29scykgJiYgcHJvdG9jb2xzLmluZGV4T2YoJ2JpbmFyeScpID4gLTEpIHtcbiAgICAgICAgICAgICAgICBwcm90b2NvbHMgPSAnYmluYXJ5JztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCF3c2J0KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwibm9WTkMgbm8gbG9uZ2VyIHN1cHBvcnRzIGJhc2U2NCBXZWJTb2NrZXRzLiAgXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIlBsZWFzZSB1c2UgYSBicm93c2VyIHdoaWNoIHN1cHBvcnRzIGJpbmFyeSBXZWJTb2NrZXRzLlwiKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHByb3RvY29scyAhPSAnYmluYXJ5Jykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIm5vVk5DIG5vIGxvbmdlciBzdXBwb3J0cyBiYXNlNjQgV2ViU29ja2V0cy4gIFBsZWFzZSBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwidXNlIHRoZSBiaW5hcnkgc3VicHJvdG9jb2wgaW5zdGVhZC5cIik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBwcm90b2NvbHM7XG4gICAgICAgIH0sXG5cbiAgICAgICAgb3BlbjogZnVuY3Rpb24gKHVyaSwgcHJvdG9jb2xzKSB7XG4gICAgICAgICAgICB2YXIgd3Nfc2NoZW1hID0gdXJpLm1hdGNoKC9eKFthLXpdKyk6XFwvXFwvLylbMV07XG4gICAgICAgICAgICBwcm90b2NvbHMgPSB0aGlzLmluaXQocHJvdG9jb2xzLCB3c19zY2hlbWEpO1xuXG4gICAgICAgICAgICB0aGlzLl93ZWJzb2NrZXQgPSBuZXcgV2ViU29ja2V0KHVyaSwgcHJvdG9jb2xzKTtcblxuICAgICAgICAgICAgaWYgKHByb3RvY29scy5pbmRleE9mKCdiaW5hcnknKSA+PSAwKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fd2Vic29ja2V0LmJpbmFyeVR5cGUgPSAnYXJyYXlidWZmZXInO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aGlzLl93ZWJzb2NrZXQub25tZXNzYWdlID0gdGhpcy5fcmVjdl9tZXNzYWdlLmJpbmQodGhpcyk7XG4gICAgICAgICAgICB0aGlzLl93ZWJzb2NrZXQub25vcGVuID0gKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBVdGlsLkRlYnVnKCc+PiBXZWJTb2NrLm9ub3BlbicpO1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl93ZWJzb2NrZXQucHJvdG9jb2wpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fbW9kZSA9IHRoaXMuX3dlYnNvY2tldC5wcm90b2NvbDtcbiAgICAgICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiU2VydmVyIGNob29zZSBzdWItcHJvdG9jb2w6IFwiICsgdGhpcy5fd2Vic29ja2V0LnByb3RvY29sKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9tb2RlID0gJ2JpbmFyeSc7XG4gICAgICAgICAgICAgICAgICAgIFV0aWwuRXJyb3IoJ1NlcnZlciBzZWxlY3Qgbm8gc3ViLXByb3RvY29sITogJyArIHRoaXMuX3dlYnNvY2tldC5wcm90b2NvbCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuX21vZGUgIT0gJ2JpbmFyeScpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwibm9WTkMgbm8gbG9uZ2VyIHN1cHBvcnRzIGJhc2U2NCBXZWJTb2NrZXRzLiAgUGxlYXNlIFwiICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwidXNlIHRoZSBiaW5hcnkgc3VicHJvdG9jb2wgaW5zdGVhZC5cIik7XG5cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB0aGlzLl9ldmVudEhhbmRsZXJzLm9wZW4oKTtcbiAgICAgICAgICAgICAgICBVdGlsLkRlYnVnKFwiPDwgV2ViU29jay5vbm9wZW5cIik7XG4gICAgICAgICAgICB9KS5iaW5kKHRoaXMpO1xuICAgICAgICAgICAgdGhpcy5fd2Vic29ja2V0Lm9uY2xvc2UgPSAoZnVuY3Rpb24gKGUpIHtcbiAgICAgICAgICAgICAgICBVdGlsLkRlYnVnKFwiPj4gV2ViU29jay5vbmNsb3NlXCIpO1xuICAgICAgICAgICAgICAgIHRoaXMuX2V2ZW50SGFuZGxlcnMuY2xvc2UoZSk7XG4gICAgICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIjw8IFdlYlNvY2sub25jbG9zZVwiKTtcbiAgICAgICAgICAgIH0pLmJpbmQodGhpcyk7XG4gICAgICAgICAgICB0aGlzLl93ZWJzb2NrZXQub25lcnJvciA9IChmdW5jdGlvbiAoZSkge1xuICAgICAgICAgICAgICAgIFV0aWwuRGVidWcoXCI+PiBXZWJTb2NrLm9uZXJyb3I6IFwiICsgZSk7XG4gICAgICAgICAgICAgICAgdGhpcy5fZXZlbnRIYW5kbGVycy5lcnJvcihlKTtcbiAgICAgICAgICAgICAgICBVdGlsLkRlYnVnKFwiPDwgV2ViU29jay5vbmVycm9yOiBcIiArIGUpO1xuICAgICAgICAgICAgfSkuYmluZCh0aGlzKTtcbiAgICAgICAgfSxcblxuICAgICAgICBjbG9zZTogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3dlYnNvY2tldCkge1xuICAgICAgICAgICAgICAgIGlmICgodGhpcy5fd2Vic29ja2V0LnJlYWR5U3RhdGUgPT09IFdlYlNvY2tldC5PUEVOKSB8fFxuICAgICAgICAgICAgICAgICAgICAgICAgKHRoaXMuX3dlYnNvY2tldC5yZWFkeVN0YXRlID09PSBXZWJTb2NrZXQuQ09OTkVDVElORykpIHtcbiAgICAgICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiQ2xvc2luZyBXZWJTb2NrZXQgY29ubmVjdGlvblwiKTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fd2Vic29ja2V0LmNsb3NlKCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhpcy5fd2Vic29ja2V0Lm9ubWVzc2FnZSA9IGZ1bmN0aW9uIChlKSB7IHJldHVybjsgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICAvLyBwcml2YXRlIG1ldGhvZHNcbiAgICAgICAgX2VuY29kZV9tZXNzYWdlOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAvLyBQdXQgaW4gYSBiaW5hcnkgYXJyYXlidWZmZXJcbiAgICAgICAgICAgIC8vIGFjY29yZGluZyB0byB0aGUgc3BlYywgeW91IGNhbiBzZW5kIEFycmF5QnVmZmVyVmlld3Mgd2l0aCB0aGUgc2VuZCBtZXRob2RcbiAgICAgICAgICAgIHJldHVybiBuZXcgVWludDhBcnJheSh0aGlzLl9zUS5idWZmZXIsIDAsIHRoaXMuX3NRbGVuKTtcbiAgICAgICAgfSxcblxuICAgICAgICBfZXhwYW5kX2NvbXBhY3RfclE6IGZ1bmN0aW9uIChtaW5fZml0KSB7XG4gICAgICAgICAgICB2YXIgcmVzaXplTmVlZGVkID0gbWluX2ZpdCB8fCB0aGlzLl9yUWxlbiAtIHRoaXMuX3JRaSA+IHRoaXMuX3JRYnVmZmVyU2l6ZSAvIDI7XG4gICAgICAgICAgICBpZiAocmVzaXplTmVlZGVkKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFtaW5fZml0KSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGp1c3QgZG91YmxlIHRoZSBzaXplIGlmIHdlIG5lZWQgdG8gZG8gY29tcGFjdGlvblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9yUWJ1ZmZlclNpemUgKj0gMjtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvLyBvdGhlcndpc2UsIG1ha2Ugc3VyZSB3ZSBzYXRpc3kgclFsZW4gLSByUWkgKyBtaW5fZml0IDwgclFidWZmZXJTaXplIC8gOFxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9yUWJ1ZmZlclNpemUgPSAodGhpcy5fclFsZW4gLSB0aGlzLl9yUWkgKyBtaW5fZml0KSAqIDg7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyB3ZSBkb24ndCB3YW50IHRvIGdyb3cgdW5ib3VuZGVkbHlcbiAgICAgICAgICAgIGlmICh0aGlzLl9yUWJ1ZmZlclNpemUgPiBNQVhfUlFfR1JPV19TSVpFKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fclFidWZmZXJTaXplID0gTUFYX1JRX0dST1dfU0laRTtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fclFidWZmZXJTaXplIC0gdGhpcy5fclFsZW4gLSB0aGlzLl9yUWkgPCBtaW5fZml0KSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFeGNlcHRpb24oXCJSZWNlaXZlIFF1ZXVlIGJ1ZmZlciBleGNlZWRlZCBcIiArIE1BWF9SUV9HUk9XX1NJWkUgKyBcIiBieXRlcywgYW5kIHRoZSBuZXcgbWVzc2FnZSBjb3VsZCBub3QgZml0XCIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHJlc2l6ZU5lZWRlZCkge1xuICAgICAgICAgICAgICAgIHZhciBvbGRfclFidWZmZXIgPSB0aGlzLl9yUS5idWZmZXI7XG4gICAgICAgICAgICAgICAgdGhpcy5fclFtYXggPSB0aGlzLl9yUWJ1ZmZlclNpemUgLyA4O1xuICAgICAgICAgICAgICAgIHRoaXMuX3JRID0gbmV3IFVpbnQ4QXJyYXkodGhpcy5fclFidWZmZXJTaXplKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9yUS5zZXQobmV3IFVpbnQ4QXJyYXkob2xkX3JRYnVmZmVyLCB0aGlzLl9yUWkpKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgaWYgKEVOQUJMRV9DT1BZV0lUSElOKSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3JRLmNvcHlXaXRoaW4oMCwgdGhpcy5fclFpKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9yUS5zZXQobmV3IFVpbnQ4QXJyYXkodGhpcy5fclEuYnVmZmVyLCB0aGlzLl9yUWkpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuX3JRbGVuID0gdGhpcy5fclFsZW4gLSB0aGlzLl9yUWk7XG4gICAgICAgICAgICB0aGlzLl9yUWkgPSAwO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9kZWNvZGVfbWVzc2FnZTogZnVuY3Rpb24gKGRhdGEpIHtcbiAgICAgICAgICAgIC8vIHB1c2ggYXJyYXlidWZmZXIgdmFsdWVzIG9udG8gdGhlIGVuZFxuICAgICAgICAgICAgdmFyIHU4ID0gbmV3IFVpbnQ4QXJyYXkoZGF0YSk7XG4gICAgICAgICAgICBpZiAodTgubGVuZ3RoID4gdGhpcy5fclFidWZmZXJTaXplIC0gdGhpcy5fclFsZW4pIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9leHBhbmRfY29tcGFjdF9yUSh1OC5sZW5ndGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5fclEuc2V0KHU4LCB0aGlzLl9yUWxlbik7XG4gICAgICAgICAgICB0aGlzLl9yUWxlbiArPSB1OC5sZW5ndGg7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX3JlY3ZfbWVzc2FnZTogZnVuY3Rpb24gKGUpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fZGVjb2RlX21lc3NhZ2UoZS5kYXRhKTtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5yUWxlbigpID4gMCkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudEhhbmRsZXJzLm1lc3NhZ2UoKTtcbiAgICAgICAgICAgICAgICAgICAgLy8gQ29tcGFjdCB0aGUgcmVjZWl2ZSBxdWV1ZVxuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fclFsZW4gPT0gdGhpcy5fclFpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9yUWxlbiA9IDA7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9yUWkgPSAwO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMuX3JRbGVuID4gdGhpcy5fclFtYXgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2V4cGFuZF9jb21wYWN0X3JRKCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBVdGlsLkRlYnVnKFwiSWdub3JpbmcgZW1wdHkgbWVzc2FnZVwiKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIChleGMpIHtcbiAgICAgICAgICAgICAgICB2YXIgZXhjZXB0aW9uX3N0ciA9IFwiXCI7XG4gICAgICAgICAgICAgICAgaWYgKGV4Yy5uYW1lKSB7XG4gICAgICAgICAgICAgICAgICAgIGV4Y2VwdGlvbl9zdHIgKz0gXCJcXG4gICAgbmFtZTogXCIgKyBleGMubmFtZSArIFwiXFxuXCI7XG4gICAgICAgICAgICAgICAgICAgIGV4Y2VwdGlvbl9zdHIgKz0gXCIgICAgbWVzc2FnZTogXCIgKyBleGMubWVzc2FnZSArIFwiXFxuXCI7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBleGMuZGVzY3JpcHRpb24gIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgICAgICAgICAgIGV4Y2VwdGlvbl9zdHIgKz0gXCIgICAgZGVzY3JpcHRpb246IFwiICsgZXhjLmRlc2NyaXB0aW9uICsgXCJcXG5cIjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGV4Yy5zdGFjayAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgICAgICAgICAgZXhjZXB0aW9uX3N0ciArPSBleGMuc3RhY2s7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGV4Y2VwdGlvbl9zdHIubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBVdGlsLkVycm9yKFwicmVjdl9tZXNzYWdlLCBjYXVnaHQgZXhjZXB0aW9uOiBcIiArIGV4Y2VwdGlvbl9zdHIpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIFV0aWwuRXJyb3IoXCJyZWN2X21lc3NhZ2UsIGNhdWdodCBleGNlcHRpb246IFwiICsgZXhjKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGV4Yy5uYW1lICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudEhhbmRsZXJzLmVycm9yKGV4Yy5uYW1lICsgXCI6IFwiICsgZXhjLm1lc3NhZ2UpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2V2ZW50SGFuZGxlcnMuZXJyb3IoZXhjKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9O1xufSkoKTtcbiJdfQ==