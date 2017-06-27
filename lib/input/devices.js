"use strict";

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.Mouse = exports.Keyboard = undefined;

var _util = require("../util");

var _util2 = _interopRequireDefault(_util);

var _util3 = require("./util");

var _util4 = _interopRequireDefault(_util3);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2012 Joel Martin
 * Copyright (C) 2013 Samuel Mannehed for Cendio AB
 * Licensed under MPL 2.0 or any later version (see LICENSE.txt)
 */

/*jslint browser: true, white: false */
/*global window, Util */

var Keyboard = exports.Keyboard = undefined;

(function () {
    "use strict";

    //
    // Keyboard event handler
    //

    exports.Keyboard = Keyboard = function (defaults) {
        this._keyDownList = []; // List of depressed keys
        // (even if they are happy)

        _util2.default.set_defaults(this, defaults, {
            'target': document,
            'focused': true
        });

        // create the keyboard handler
        this._handler = new _util4.default.KeyEventDecoder(_util4.default.ModifierSync(), _util4.default.VerifyCharModifier( /* jshint newcap: false */
        _util4.default.TrackKeyState(_util4.default.EscapeModifiers(this._handleRfbEvent.bind(this))))); /* jshint newcap: true */

        // keep these here so we can refer to them later
        this._eventHandlers = {
            'keyup': this._handleKeyUp.bind(this),
            'keydown': this._handleKeyDown.bind(this),
            'keypress': this._handleKeyPress.bind(this),
            'blur': this._allKeysUp.bind(this)
        };
    };

    Keyboard.prototype = {
        // private methods

        _handleRfbEvent: function (e) {
            if (this._onKeyPress) {
                _util2.default.Debug("onKeyPress " + (e.type == 'keydown' ? "down" : "up") + ", keysym: " + e.keysym.keysym + "(" + e.keysym.keyname + ")");
                this._onKeyPress(e);
            }
        },

        setQEMUVNCKeyboardHandler: function () {
            this._handler = new _util4.default.QEMUKeyEventDecoder(_util4.default.ModifierSync(), _util4.default.TrackQEMUKeyState(this._handleRfbEvent.bind(this)));
        },

        _handleKeyDown: function (e) {
            if (!this._focused) {
                return true;
            }

            if (this._handler.keydown(e)) {
                // Suppress bubbling/default actions
                _util2.default.stopEvent(e);
                return false;
            } else {
                // Allow the event to bubble and become a keyPress event which
                // will have the character code translated
                return true;
            }
        },

        _handleKeyPress: function (e) {
            if (!this._focused) {
                return true;
            }

            if (this._handler.keypress(e)) {
                // Suppress bubbling/default actions
                _util2.default.stopEvent(e);
                return false;
            } else {
                // Allow the event to bubble and become a keyPress event which
                // will have the character code translated
                return true;
            }
        },

        _handleKeyUp: function (e) {
            if (!this._focused) {
                return true;
            }

            if (this._handler.keyup(e)) {
                // Suppress bubbling/default actions
                _util2.default.stopEvent(e);
                return false;
            } else {
                // Allow the event to bubble and become a keyPress event which
                // will have the character code translated
                return true;
            }
        },

        _allKeysUp: function () {
            _util2.default.Debug(">> Keyboard.allKeysUp");
            this._handler.releaseAll();
            _util2.default.Debug("<< Keyboard.allKeysUp");
        },

        // Public methods

        grab: function () {
            //Util.Debug(">> Keyboard.grab");
            var c = this._target;

            c.addEventListener('keydown', this._eventHandlers.keydown);
            c.addEventListener('keyup', this._eventHandlers.keyup);
            c.addEventListener('keypress', this._eventHandlers.keypress);

            // Release (key up) if window loses focus
            window.addEventListener('blur', this._eventHandlers.blur);

            //Util.Debug("<< Keyboard.grab");
        },

        ungrab: function () {
            //Util.Debug(">> Keyboard.ungrab");
            var c = this._target;

            c.removeEventListener('keydown', this._eventHandlers.keydown);
            c.removeEventListener('keyup', this._eventHandlers.keyup);
            c.removeEventListener('keypress', this._eventHandlers.keypress);
            window.removeEventListener('blur', this._eventHandlers.blur);

            // Release (key up) all keys that are in a down state
            this._allKeysUp();

            //Util.Debug(">> Keyboard.ungrab");
        },

        sync: function (e) {
            this._handler.syncModifiers(e);
        }
    };

    _util2.default.make_properties(Keyboard, [['target', 'wo', 'dom'], // DOM element that captures keyboard input
    ['focused', 'rw', 'bool'], // Capture and send key events

    ['onKeyPress', 'rw', 'func'] // Handler for key press/release
    ]);
})();

var Mouse = exports.Mouse = undefined;

(function () {
    exports.Mouse = Mouse = function (defaults) {
        this._mouseCaptured = false;

        this._doubleClickTimer = null;
        this._lastTouchPos = null;

        // Configuration attributes
        _util2.default.set_defaults(this, defaults, {
            'target': document,
            'focused': true,
            'scale': 1.0,
            'touchButton': 1
        });

        this._eventHandlers = {
            'mousedown': this._handleMouseDown.bind(this),
            'mouseup': this._handleMouseUp.bind(this),
            'mousemove': this._handleMouseMove.bind(this),
            'mousewheel': this._handleMouseWheel.bind(this),
            'mousedisable': this._handleMouseDisable.bind(this)
        };
    };

    Mouse.prototype = {
        // private methods
        _captureMouse: function () {
            // capturing the mouse ensures we get the mouseup event
            if (this._target.setCapture) {
                this._target.setCapture();
            }

            // some browsers give us mouseup events regardless,
            // so if we never captured the mouse, we can disregard the event
            this._mouseCaptured = true;
        },

        _releaseMouse: function () {
            if (this._target.releaseCapture) {
                this._target.releaseCapture();
            }
            this._mouseCaptured = false;
        },

        _resetDoubleClickTimer: function () {
            this._doubleClickTimer = null;
        },

        _handleMouseButton: function (e, down) {
            if (!this._focused) {
                return true;
            }

            if (this._notify) {
                this._notify(e);
            }

            var evt = e ? e : window.event;
            var pos = _util2.default.getEventPosition(e, this._target, this._scale);

            var bmask;
            if (e.touches || e.changedTouches) {
                // Touch device

                // When two touches occur within 500 ms of each other and are
                // close enough together a double click is triggered.
                if (down == 1) {
                    if (this._doubleClickTimer === null) {
                        this._lastTouchPos = pos;
                    } else {
                        clearTimeout(this._doubleClickTimer);

                        // When the distance between the two touches is small enough
                        // force the position of the latter touch to the position of
                        // the first.

                        var xs = this._lastTouchPos.x - pos.x;
                        var ys = this._lastTouchPos.y - pos.y;
                        var d = Math.sqrt(xs * xs + ys * ys);

                        // The goal is to trigger on a certain physical width, the
                        // devicePixelRatio brings us a bit closer but is not optimal.
                        var threshold = 20 * (window.devicePixelRatio || 1);
                        if (d < threshold) {
                            pos = this._lastTouchPos;
                        }
                    }
                    this._doubleClickTimer = setTimeout(this._resetDoubleClickTimer.bind(this), 500);
                }
                bmask = this._touchButton;
                // If bmask is set
            } else if (evt.which) {
                /* everything except IE */
                bmask = 1 << evt.button;
            } else {
                /* IE including 9 */
                bmask = (evt.button & 0x1) + // Left
                (evt.button & 0x2) * 2 + // Right
                (evt.button & 0x4) / 2; // Middle
            }

            if (this._onMouseButton) {
                _util2.default.Debug("onMouseButton " + (down ? "down" : "up") + ", x: " + pos.x + ", y: " + pos.y + ", bmask: " + bmask);
                this._onMouseButton(pos.x, pos.y, down, bmask);
            }
            _util2.default.stopEvent(e);
            return false;
        },

        _handleMouseDown: function (e) {
            this._captureMouse();
            this._handleMouseButton(e, 1);
        },

        _handleMouseUp: function (e) {
            if (!this._mouseCaptured) {
                return;
            }

            this._handleMouseButton(e, 0);
            this._releaseMouse();
        },

        _handleMouseWheel: function (e) {
            if (!this._focused) {
                return true;
            }

            if (this._notify) {
                this._notify(e);
            }

            var evt = e ? e : window.event;
            var pos = _util2.default.getEventPosition(e, this._target, this._scale);
            var wheelData = evt.detail ? evt.detail * -1 : evt.wheelDelta / 40;
            var bmask;
            if (wheelData > 0) {
                bmask = 1 << 3;
            } else {
                bmask = 1 << 4;
            }

            if (this._onMouseButton) {
                this._onMouseButton(pos.x, pos.y, 1, bmask);
                this._onMouseButton(pos.x, pos.y, 0, bmask);
            }
            _util2.default.stopEvent(e);
            return false;
        },

        _handleMouseMove: function (e) {
            if (!this._focused) {
                return true;
            }

            if (this._notify) {
                this._notify(e);
            }

            var evt = e ? e : window.event;
            var pos = _util2.default.getEventPosition(e, this._target, this._scale);
            if (this._onMouseMove) {
                this._onMouseMove(pos.x, pos.y);
            }
            _util2.default.stopEvent(e);
            return false;
        },

        _handleMouseDisable: function (e) {
            if (!this._focused) {
                return true;
            }

            var evt = e ? e : window.event;
            var pos = _util2.default.getEventPosition(e, this._target, this._scale);

            /* Stop propagation if inside canvas area */
            if (pos.realx >= 0 && pos.realy >= 0 && pos.realx < this._target.offsetWidth && pos.realy < this._target.offsetHeight) {
                //Util.Debug("mouse event disabled");
                _util2.default.stopEvent(e);
                return false;
            }

            return true;
        },

        // Public methods
        grab: function () {
            var c = this._target;

            if ('ontouchstart' in document.documentElement) {
                c.addEventListener('touchstart', this._eventHandlers.mousedown);
                window.addEventListener('touchend', this._eventHandlers.mouseup);
                c.addEventListener('touchend', this._eventHandlers.mouseup);
                c.addEventListener('touchmove', this._eventHandlers.mousemove);
            }
            c.addEventListener('mousedown', this._eventHandlers.mousedown);
            window.addEventListener('mouseup', this._eventHandlers.mouseup);
            c.addEventListener('mouseup', this._eventHandlers.mouseup);
            c.addEventListener('mousemove', this._eventHandlers.mousemove);
            c.addEventListener(_util2.default.Engine.gecko ? 'DOMMouseScroll' : 'mousewheel', this._eventHandlers.mousewheel);

            /* Work around right and middle click browser behaviors */
            document.addEventListener('click', this._eventHandlers.mousedisable);
            document.body.addEventListener('contextmenu', this._eventHandlers.mousedisable);
        },

        ungrab: function () {
            var c = this._target;

            if ('ontouchstart' in document.documentElement) {
                c.removeEventListener('touchstart', this._eventHandlers.mousedown);
                window.removeEventListener('touchend', this._eventHandlers.mouseup);
                c.removeEventListener('touchend', this._eventHandlers.mouseup);
                c.removeEventListener('touchmove', this._eventHandlers.mousemove);
            }
            c.removeEventListener('mousedown', this._eventHandlers.mousedown);
            window.removeEventListener('mouseup', this._eventHandlers.mouseup);
            c.removeEventListener('mouseup', this._eventHandlers.mouseup);
            c.removeEventListener('mousemove', this._eventHandlers.mousemove);
            c.removeEventListener(_util2.default.Engine.gecko ? 'DOMMouseScroll' : 'mousewheel', this._eventHandlers.mousewheel);

            /* Work around right and middle click browser behaviors */
            document.removeEventListener('click', this._eventHandlers.mousedisable);
            document.body.removeEventListener('contextmenu', this._eventHandlers.mousedisable);
        }
    };

    _util2.default.make_properties(Mouse, [['target', 'ro', 'dom'], // DOM element that captures mouse input
    ['notify', 'ro', 'func'], // Function to call to notify whenever a mouse event is received
    ['focused', 'rw', 'bool'], // Capture and send mouse clicks/movement
    ['scale', 'rw', 'float'], // Viewport scale factor 0.0 - 1.0

    ['onMouseButton', 'rw', 'func'], // Handler for mouse button click/release
    ['onMouseMove', 'rw', 'func'], // Handler for mouse movement
    ['touchButton', 'rw', 'int'] // Button mask (1, 2, 4) for touch devices (0 means ignore clicks)
    ]);
})();
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImRldmljZXMuanMiXSwibmFtZXMiOlsiS2V5Ym9hcmQiLCJkZWZhdWx0cyIsIl9rZXlEb3duTGlzdCIsInNldF9kZWZhdWx0cyIsImRvY3VtZW50IiwiX2hhbmRsZXIiLCJLZXlFdmVudERlY29kZXIiLCJNb2RpZmllclN5bmMiLCJWZXJpZnlDaGFyTW9kaWZpZXIiLCJUcmFja0tleVN0YXRlIiwiRXNjYXBlTW9kaWZpZXJzIiwiX2hhbmRsZVJmYkV2ZW50IiwiYmluZCIsIl9ldmVudEhhbmRsZXJzIiwiX2hhbmRsZUtleVVwIiwiX2hhbmRsZUtleURvd24iLCJfaGFuZGxlS2V5UHJlc3MiLCJfYWxsS2V5c1VwIiwicHJvdG90eXBlIiwiZSIsIl9vbktleVByZXNzIiwiRGVidWciLCJ0eXBlIiwia2V5c3ltIiwia2V5bmFtZSIsInNldFFFTVVWTkNLZXlib2FyZEhhbmRsZXIiLCJRRU1VS2V5RXZlbnREZWNvZGVyIiwiVHJhY2tRRU1VS2V5U3RhdGUiLCJfZm9jdXNlZCIsImtleWRvd24iLCJzdG9wRXZlbnQiLCJrZXlwcmVzcyIsImtleXVwIiwicmVsZWFzZUFsbCIsImdyYWIiLCJjIiwiX3RhcmdldCIsImFkZEV2ZW50TGlzdGVuZXIiLCJ3aW5kb3ciLCJibHVyIiwidW5ncmFiIiwicmVtb3ZlRXZlbnRMaXN0ZW5lciIsInN5bmMiLCJzeW5jTW9kaWZpZXJzIiwibWFrZV9wcm9wZXJ0aWVzIiwiTW91c2UiLCJfbW91c2VDYXB0dXJlZCIsIl9kb3VibGVDbGlja1RpbWVyIiwiX2xhc3RUb3VjaFBvcyIsIl9oYW5kbGVNb3VzZURvd24iLCJfaGFuZGxlTW91c2VVcCIsIl9oYW5kbGVNb3VzZU1vdmUiLCJfaGFuZGxlTW91c2VXaGVlbCIsIl9oYW5kbGVNb3VzZURpc2FibGUiLCJfY2FwdHVyZU1vdXNlIiwic2V0Q2FwdHVyZSIsIl9yZWxlYXNlTW91c2UiLCJyZWxlYXNlQ2FwdHVyZSIsIl9yZXNldERvdWJsZUNsaWNrVGltZXIiLCJfaGFuZGxlTW91c2VCdXR0b24iLCJkb3duIiwiX25vdGlmeSIsImV2dCIsImV2ZW50IiwicG9zIiwiZ2V0RXZlbnRQb3NpdGlvbiIsIl9zY2FsZSIsImJtYXNrIiwidG91Y2hlcyIsImNoYW5nZWRUb3VjaGVzIiwiY2xlYXJUaW1lb3V0IiwieHMiLCJ4IiwieXMiLCJ5IiwiZCIsIk1hdGgiLCJzcXJ0IiwidGhyZXNob2xkIiwiZGV2aWNlUGl4ZWxSYXRpbyIsInNldFRpbWVvdXQiLCJfdG91Y2hCdXR0b24iLCJ3aGljaCIsImJ1dHRvbiIsIl9vbk1vdXNlQnV0dG9uIiwid2hlZWxEYXRhIiwiZGV0YWlsIiwid2hlZWxEZWx0YSIsIl9vbk1vdXNlTW92ZSIsInJlYWx4IiwicmVhbHkiLCJvZmZzZXRXaWR0aCIsIm9mZnNldEhlaWdodCIsImRvY3VtZW50RWxlbWVudCIsIm1vdXNlZG93biIsIm1vdXNldXAiLCJtb3VzZW1vdmUiLCJFbmdpbmUiLCJnZWNrbyIsIm1vdXNld2hlZWwiLCJtb3VzZWRpc2FibGUiLCJib2R5Il0sIm1hcHBpbmdzIjoiOzs7Ozs7O0FBVUE7Ozs7QUFDQTs7Ozs7O0FBWEE7Ozs7Ozs7QUFPQTtBQUNBOztBQU1PLElBQUlBLHVDQUFKOztBQUVQLENBQUMsWUFBWTtBQUNUOztBQUVBO0FBQ0E7QUFDQTs7QUFFQSxZQVRPQSxRQVNQLGNBQVcsVUFBVUMsUUFBVixFQUFvQjtBQUMzQixhQUFLQyxZQUFMLEdBQW9CLEVBQXBCLENBRDJCLENBQ0s7QUFDQTs7QUFFaEMsdUJBQUtDLFlBQUwsQ0FBa0IsSUFBbEIsRUFBd0JGLFFBQXhCLEVBQWtDO0FBQzlCLHNCQUFVRyxRQURvQjtBQUU5Qix1QkFBVztBQUZtQixTQUFsQzs7QUFLQTtBQUNBLGFBQUtDLFFBQUwsR0FBZ0IsSUFBSSxlQUFhQyxlQUFqQixDQUFpQyxlQUFhQyxZQUFiLEVBQWpDLEVBQ1osZUFBYUMsa0JBQWIsRUFBaUM7QUFDN0IsdUJBQWFDLGFBQWIsQ0FDSSxlQUFhQyxlQUFiLENBQTZCLEtBQUtDLGVBQUwsQ0FBcUJDLElBQXJCLENBQTBC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O0FBQ25DLEtBQUMsUUFBRCxFQUFtQixJQUFuQixFQUF5QixNQUF6QixDQUZ3QixFQUVXO0FBQ25DLEtBQUMsU0FBRCxFQUFtQixJQUFuQixFQUF5QixNQUF6QixDQUh3QixFQUdXO0FBQ25DLEtBQUMsT0FBRCxFQUFtQixJQUFuQixFQUF5QixPQUF6QixDQUp3QixFQUlXOztBQUVuQyxLQUFDLGVBQUQsRUFBbUIsSUFBbkIsRUFBeUIsTUFBekIsQ0FOd0IsRUFNVztBQUNuQyxLQUFDLGFBQUQsRUFBbUIsSUFBbkIsRUFBeUIsTUFBekIsQ0FQd0IsRUFPVztBQUNuQyxLQUFDLGFBQUQsRUFBbUIsSUFBbkIsRUFBeUIsS0FBekIsQ0FSd0IsQ0FRVztBQVJYLEtBQTVCO0FBVUgsQ0EzT0QiLCJmaWxlIjoiZGV2aWNlcy5qcyIsInNvdXJjZXNDb250ZW50IjpbIi8qXG4gKiBub1ZOQzogSFRNTDUgVk5DIGNsaWVudFxuICogQ29weXJpZ2h0IChDKSAyMDEyIEpvZWwgTWFydGluXG4gKiBDb3B5cmlnaHQgKEMpIDIwMTMgU2FtdWVsIE1hbm5laGVkIGZvciBDZW5kaW8gQUJcbiAqIExpY2Vuc2VkIHVuZGVyIE1QTCAyLjAgb3IgYW55IGxhdGVyIHZlcnNpb24gKHNlZSBMSUNFTlNFLnR4dClcbiAqL1xuXG4vKmpzbGludCBicm93c2VyOiB0cnVlLCB3aGl0ZTogZmFsc2UgKi9cbi8qZ2xvYmFsIHdpbmRvdywgVXRpbCAqL1xuXG5pbXBvcnQgVXRpbCBmcm9tIFwiLi4vdXRpbFwiO1xuaW1wb3J0IEtleWJvYXJkVXRpbCBmcm9tIFwiLi91dGlsXCI7XG5cblxuZXhwb3J0IHZhciBLZXlib2FyZDtcblxuKGZ1bmN0aW9uICgpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcblxuICAgIC8vXG4gICAgLy8gS2V5Ym9hcmQgZXZlbnQgaGFuZGxlclxuICAgIC8vXG5cbiAgICBLZXlib2FyZCA9IGZ1bmN0aW9uIChkZWZhdWx0cykge1xuICAgICAgICB0aGlzLl9rZXlEb3duTGlzdCA9IFtdOyAgICAgICAgIC8vIExpc3Qgb2YgZGVwcmVzc2VkIGtleXNcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyAoZXZlbiBpZiB0aGV5IGFyZSBoYXBweSlcblxuICAgICAgICBVdGlsLnNldF9kZWZhdWx0cyh0aGlzLCBkZWZhdWx0cywge1xuICAgICAgICAgICAgJ3RhcmdldCc6IGRvY3VtZW50LFxuICAgICAgICAgICAgJ2ZvY3VzZWQnOiB0cnVlXG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIGNyZWF0ZSB0aGUga2V5Ym9hcmQgaGFuZGxlclxuICAgICAgICB0aGlzLl9oYW5kbGVyID0gbmV3IEtleWJvYXJkVXRpbC5LZXlFdmVudERlY29kZXIoS2V5Ym9hcmRVdGlsLk1vZGlmaWVyU3luYygpLFxuICAgICAgICAgICAgS2V5Ym9hcmRVdGlsLlZlcmlmeUNoYXJNb2RpZmllciggLyoganNoaW50IG5ld2NhcDogZmFsc2UgKi9cbiAgICAgICAgICAgICAgICBLZXlib2FyZFV0aWwuVHJhY2tLZXlTdGF0ZShcbiAgICAgICAgICAgICAgICAgICAgS2V5Ym9hcmRVdGlsLkVzY2FwZU1vZGlmaWVycyh0aGlzLl9oYW5kbGVSZmJFdmVudC5iaW5kKHRoaXMpKVxuICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgIClcbiAgICAgICAgKTsgLyoganNoaW50IG5ld2NhcDogdHJ1ZSAqL1xuXG4gICAgICAgIC8vIGtlZXAgdGhlc2UgaGVyZSBzbyB3ZSBjYW4gcmVmZXIgdG8gdGhlbSBsYXRlclxuICAgICAgICB0aGlzLl9ldmVudEhhbmRsZXJzID0ge1xuICAgICAgICAgICAgJ2tleXVwJzogdGhpcy5faGFuZGxlS2V5VXAuYmluZCh0aGlzKSxcbiAgICAgICAgICAgICdrZXlkb3duJzogdGhpcy5faGFuZGxlS2V5RG93bi5iaW5kKHRoaXMpLFxuICAgICAgICAgICAgJ2tleXByZXNzJzogdGhpcy5faGFuZGxlS2V5UHJlc3MuYmluZCh0aGlzKSxcbiAgICAgICAgICAgICdibHVyJzogdGhpcy5fYWxsS2V5c1VwLmJpbmQodGhpcylcbiAgICAgICAgfTtcbiAgICB9O1xuXG4gICAgS2V5Ym9hcmQucHJvdG90eXBlID0ge1xuICAgICAgICAvLyBwcml2YXRlIG1ldGhvZHNcblxuICAgICAgICBfaGFuZGxlUmZiRXZlbnQ6IGZ1bmN0aW9uIChlKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fb25LZXlQcmVzcykge1xuICAgICAgICAgICAgICAgIFV0aWwuRGVidWcoXCJvbktleVByZXNzIFwiICsgKGUudHlwZSA9PSAna2V5ZG93bicgPyBcImRvd25cIiA6IFwidXBcIikgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgXCIsIGtleXN5bTogXCIgKyBlLmtleXN5bS5rZXlzeW0gKyBcIihcIiArIGUua2V5c3ltLmtleW5hbWUgKyBcIilcIik7XG4gICAgICAgICAgICAgICAgdGhpcy5fb25LZXlQcmVzcyhlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBzZXRRRU1VVk5DS2V5Ym9hcmRIYW5kbGVyOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB0aGlzLl9oYW5kbGVyID0gbmV3IEtleWJvYXJkVXRpbC5RRU1VS2V5RXZlbnREZWNvZGVyKEtleWJvYXJkVXRpbC5Nb2RpZmllclN5bmMoKSxcbiAgICAgICAgICAgICAgICBLZXlib2FyZFV0aWwuVHJhY2tRRU1VS2V5U3RhdGUoXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2hhbmRsZVJmYkV2ZW50LmJpbmQodGhpcylcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICApO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9oYW5kbGVLZXlEb3duOiBmdW5jdGlvbiAoZSkge1xuICAgICAgICAgICAgaWYgKCF0aGlzLl9mb2N1c2VkKSB7IHJldHVybiB0cnVlOyB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9oYW5kbGVyLmtleWRvd24oZSkpIHtcbiAgICAgICAgICAgICAgICAvLyBTdXBwcmVzcyBidWJibGluZy9kZWZhdWx0IGFjdGlvbnNcbiAgICAgICAgICAgICAgICBVdGlsLnN0b3BFdmVudChlKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIEFsbG93IHRoZSBldmVudCB0byBidWJibGUgYW5kIGJlY29tZSBhIGtleVByZXNzIGV2ZW50IHdoaWNoXG4gICAgICAgICAgICAgICAgLy8gd2lsbCBoYXZlIHRoZSBjaGFyYWN0ZXIgY29kZSB0cmFuc2xhdGVkXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2hhbmRsZUtleVByZXNzOiBmdW5jdGlvbiAoZSkge1xuICAgICAgICAgICAgaWYgKCF0aGlzLl9mb2N1c2VkKSB7IHJldHVybiB0cnVlOyB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9oYW5kbGVyLmtleXByZXNzKGUpKSB7XG4gICAgICAgICAgICAgICAgLy8gU3VwcHJlc3MgYnViYmxpbmcvZGVmYXVsdCBhY3Rpb25zXG4gICAgICAgICAgICAgICAgVXRpbC5zdG9wRXZlbnQoZSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBBbGxvdyB0aGUgZXZlbnQgdG8gYnViYmxlIGFuZCBiZWNvbWUgYSBrZXlQcmVzcyBldmVudCB3aGljaFxuICAgICAgICAgICAgICAgIC8vIHdpbGwgaGF2ZSB0aGUgY2hhcmFjdGVyIGNvZGUgdHJhbnNsYXRlZFxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIF9oYW5kbGVLZXlVcDogZnVuY3Rpb24gKGUpIHtcbiAgICAgICAgICAgIGlmICghdGhpcy5fZm9jdXNlZCkgeyByZXR1cm4gdHJ1ZTsgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5faGFuZGxlci5rZXl1cChlKSkge1xuICAgICAgICAgICAgICAgIC8vIFN1cHByZXNzIGJ1YmJsaW5nL2RlZmF1bHQgYWN0aW9uc1xuICAgICAgICAgICAgICAgIFV0aWwuc3RvcEV2ZW50KGUpO1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gQWxsb3cgdGhlIGV2ZW50IHRvIGJ1YmJsZSBhbmQgYmVjb21lIGEga2V5UHJlc3MgZXZlbnQgd2hpY2hcbiAgICAgICAgICAgICAgICAvLyB3aWxsIGhhdmUgdGhlIGNoYXJhY3RlciBjb2RlIHRyYW5zbGF0ZWRcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBfYWxsS2V5c1VwOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBVdGlsLkRlYnVnKFwiPj4gS2V5Ym9hcmQuYWxsS2V5c1VwXCIpO1xuICAgICAgICAgICAgdGhpcy5faGFuZGxlci5yZWxlYXNlQWxsKCk7XG4gICAgICAgICAgICBVdGlsLkRlYnVnKFwiPDwgS2V5Ym9hcmQuYWxsS2V5c1VwXCIpO1xuICAgICAgICB9LFxuXG4gICAgICAgIC8vIFB1YmxpYyBtZXRob2RzXG5cbiAgICAgICAgZ3JhYjogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgLy9VdGlsLkRlYnVnKFwiPj4gS2V5Ym9hcmQuZ3JhYlwiKTtcbiAgICAgICAgICAgIHZhciBjID0gdGhpcy5fdGFyZ2V0O1xuXG4gICAgICAgICAgICBjLmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCB0aGlzLl9ldmVudEhhbmRsZXJzLmtleWRvd24pO1xuICAgICAgICAgICAgYy5hZGRFdmVudExpc3RlbmVyKCdrZXl1cCcsIHRoaXMuX2V2ZW50SGFuZGxlcnMua2V5dXApO1xuICAgICAgICAgICAgYy5hZGRFdmVudExpc3RlbmVyKCdrZXlwcmVzcycsIHRoaXMuX2V2ZW50SGFuZGxlcnMua2V5cHJlc3MpO1xuXG4gICAgICAgICAgICAvLyBSZWxlYXNlIChrZXkgdXApIGlmIHdpbmRvdyBsb3NlcyBmb2N1c1xuICAgICAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ2JsdXInLCB0aGlzLl9ldmVudEhhbmRsZXJzLmJsdXIpO1xuXG4gICAgICAgICAgICAvL1V0aWwuRGVidWcoXCI8PCBLZXlib2FyZC5ncmFiXCIpO1xuICAgICAgICB9LFxuXG4gICAgICAgIHVuZ3JhYjogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgLy9VdGlsLkRlYnVnKFwiPj4gS2V5Ym9hcmQudW5ncmFiXCIpO1xuICAgICAgICAgICAgdmFyIGMgPSB0aGlzLl90YXJnZXQ7XG5cbiAgICAgICAgICAgIGMucmVtb3ZlRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIHRoaXMuX2V2ZW50SGFuZGxlcnMua2V5ZG93bik7XG4gICAgICAgICAgICBjLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2tleXVwJywgdGhpcy5fZXZlbnRIYW5kbGVycy5rZXl1cCk7XG4gICAgICAgICAgICBjLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2tleXByZXNzJywgdGhpcy5fZXZlbnRIYW5kbGVycy5rZXlwcmVzcyk7XG4gICAgICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcignYmx1cicsIHRoaXMuX2V2ZW50SGFuZGxlcnMuYmx1cik7XG5cbiAgICAgICAgICAgIC8vIFJlbGVhc2UgKGtleSB1cCkgYWxsIGtleXMgdGhhdCBhcmUgaW4gYSBkb3duIHN0YXRlXG4gICAgICAgICAgICB0aGlzLl9hbGxLZXlzVXAoKTtcblxuICAgICAgICAgICAgLy9VdGlsLkRlYnVnKFwiPj4gS2V5Ym9hcmQudW5ncmFiXCIpO1xuICAgICAgICB9LFxuXG4gICAgICAgIHN5bmM6IGZ1bmN0aW9uIChlKSB7XG4gICAgICAgICAgICB0aGlzLl9oYW5kbGVyLnN5bmNNb2RpZmllcnMoZSk7XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgVXRpbC5tYWtlX3Byb3BlcnRpZXMoS2V5Ym9hcmQsIFtcbiAgICAgICAgWyd0YXJnZXQnLCAgICAgJ3dvJywgJ2RvbSddLCAgLy8gRE9NIGVsZW1lbnQgdGhhdCBjYXB0dXJlcyBrZXlib2FyZCBpbnB1dFxuICAgICAgICBbJ2ZvY3VzZWQnLCAgICAncncnLCAnYm9vbCddLCAvLyBDYXB0dXJlIGFuZCBzZW5kIGtleSBldmVudHNcblxuICAgICAgICBbJ29uS2V5UHJlc3MnLCAncncnLCAnZnVuYyddIC8vIEhhbmRsZXIgZm9yIGtleSBwcmVzcy9yZWxlYXNlXG4gICAgXSk7XG59KSgpO1xuXG5leHBvcnQgdmFyIE1vdXNlO1xuXG4oZnVuY3Rpb24gKCkge1xuICAgIE1vdXNlID0gZnVuY3Rpb24gKGRlZmF1bHRzKSB7XG4gICAgICAgIHRoaXMuX21vdXNlQ2FwdHVyZWQgID0gZmFsc2U7XG5cbiAgICAgICAgdGhpcy5fZG91YmxlQ2xpY2tUaW1lciA9IG51bGw7XG4gICAgICAgIHRoaXMuX2xhc3RUb3VjaFBvcyA9IG51bGw7XG5cbiAgICAgICAgLy8gQ29uZmlndXJhdGlvbiBhdHRyaWJ1dGVzXG4gICAgICAgIFV0aWwuc2V0X2RlZmF1bHRzKHRoaXMsIGRlZmF1bHRzLCB7XG4gICAgICAgICAgICAndGFyZ2V0JzogZG9jdW1lbnQsXG4gICAgICAgICAgICAnZm9jdXNlZCc6IHRydWUsXG4gICAgICAgICAgICAnc2NhbGUnOiAxLjAsXG4gICAgICAgICAgICAndG91Y2hCdXR0b24nOiAxXG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuX2V2ZW50SGFuZGxlcnMgPSB7XG4gICAgICAgICAgICAnbW91c2Vkb3duJzogdGhpcy5faGFuZGxlTW91c2VEb3duLmJpbmQodGhpcyksXG4gICAgICAgICAgICAnbW91c2V1cCc6IHRoaXMuX2hhbmRsZU1vdXNlVXAuYmluZCh0aGlzKSxcbiAgICAgICAgICAgICdtb3VzZW1vdmUnOiB0aGlzLl9oYW5kbGVNb3VzZU1vdmUuYmluZCh0aGlzKSxcbiAgICAgICAgICAgICdtb3VzZXdoZWVsJzogdGhpcy5faGFuZGxlTW91c2VXaGVlbC5iaW5kKHRoaXMpLFxuICAgICAgICAgICAgJ21vdXNlZGlzYWJsZSc6IHRoaXMuX2hhbmRsZU1vdXNlRGlzYWJsZS5iaW5kKHRoaXMpXG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIE1vdXNlLnByb3RvdHlwZSA9IHtcbiAgICAgICAgLy8gcHJpdmF0ZSBtZXRob2RzXG4gICAgICAgIF9jYXB0dXJlTW91c2U6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIC8vIGNhcHR1cmluZyB0aGUgbW91c2UgZW5zdXJlcyB3ZSBnZXQgdGhlIG1vdXNldXAgZXZlbnRcbiAgICAgICAgICAgIGlmICh0aGlzLl90YXJnZXQuc2V0Q2FwdHVyZSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX3RhcmdldC5zZXRDYXB0dXJlKCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIHNvbWUgYnJvd3NlcnMgZ2l2ZSB1cyBtb3VzZXVwIGV2ZW50cyByZWdhcmRsZXNzLFxuICAgICAgICAgICAgLy8gc28gaWYgd2UgbmV2ZXIgY2FwdHVyZWQgdGhlIG1vdXNlLCB3ZSBjYW4gZGlzcmVnYXJkIHRoZSBldmVudFxuICAgICAgICAgICAgdGhpcy5fbW91c2VDYXB0dXJlZCA9IHRydWU7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX3JlbGVhc2VNb3VzZTogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3RhcmdldC5yZWxlYXNlQ2FwdHVyZSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX3RhcmdldC5yZWxlYXNlQ2FwdHVyZSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5fbW91c2VDYXB0dXJlZCA9IGZhbHNlO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9yZXNldERvdWJsZUNsaWNrVGltZXI6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHRoaXMuX2RvdWJsZUNsaWNrVGltZXIgPSBudWxsO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9oYW5kbGVNb3VzZUJ1dHRvbjogZnVuY3Rpb24gKGUsIGRvd24pIHtcbiAgICAgICAgICAgIGlmICghdGhpcy5fZm9jdXNlZCkgeyByZXR1cm4gdHJ1ZTsgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5fbm90aWZ5KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fbm90aWZ5KGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YXIgZXZ0ID0gKGUgPyBlIDogd2luZG93LmV2ZW50KTtcbiAgICAgICAgICAgIHZhciBwb3MgPSBVdGlsLmdldEV2ZW50UG9zaXRpb24oZSwgdGhpcy5fdGFyZ2V0LCB0aGlzLl9zY2FsZSk7XG5cbiAgICAgICAgICAgIHZhciBibWFzaztcbiAgICAgICAgICAgIGlmIChlLnRvdWNoZXMgfHwgZS5jaGFuZ2VkVG91Y2hlcykge1xuICAgICAgICAgICAgICAgIC8vIFRvdWNoIGRldmljZVxuXG4gICAgICAgICAgICAgICAgLy8gV2hlbiB0d28gdG91Y2hlcyBvY2N1ciB3aXRoaW4gNTAwIG1zIG9mIGVhY2ggb3RoZXIgYW5kIGFyZVxuICAgICAgICAgICAgICAgIC8vIGNsb3NlIGVub3VnaCB0b2dldGhlciBhIGRvdWJsZSBjbGljayBpcyB0cmlnZ2VyZWQuXG4gICAgICAgICAgICAgICAgaWYgKGRvd24gPT0gMSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fZG91YmxlQ2xpY2tUaW1lciA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fbGFzdFRvdWNoUG9zID0gcG9zO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHRoaXMuX2RvdWJsZUNsaWNrVGltZXIpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBXaGVuIHRoZSBkaXN0YW5jZSBiZXR3ZWVuIHRoZSB0d28gdG91Y2hlcyBpcyBzbWFsbCBlbm91Z2hcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGZvcmNlIHRoZSBwb3NpdGlvbiBvZiB0aGUgbGF0dGVyIHRvdWNoIHRvIHRoZSBwb3NpdGlvbiBvZlxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gdGhlIGZpcnN0LlxuXG4gICAgICAgICAgICAgICAgICAgICAgICB2YXIgeHMgPSB0aGlzLl9sYXN0VG91Y2hQb3MueCAtIHBvcy54O1xuICAgICAgICAgICAgICAgICAgICAgICAgdmFyIHlzID0gdGhpcy5fbGFzdFRvdWNoUG9zLnkgLSBwb3MueTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHZhciBkID0gTWF0aC5zcXJ0KCh4cyAqIHhzKSArICh5cyAqIHlzKSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIFRoZSBnb2FsIGlzIHRvIHRyaWdnZXIgb24gYSBjZXJ0YWluIHBoeXNpY2FsIHdpZHRoLCB0aGVcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGRldmljZVBpeGVsUmF0aW8gYnJpbmdzIHVzIGEgYml0IGNsb3NlciBidXQgaXMgbm90IG9wdGltYWwuXG4gICAgICAgICAgICAgICAgICAgICAgICB2YXIgdGhyZXNob2xkID0gMjAgKiAod2luZG93LmRldmljZVBpeGVsUmF0aW8gfHwgMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZCA8IHRocmVzaG9sZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBvcyA9IHRoaXMuX2xhc3RUb3VjaFBvcztcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9kb3VibGVDbGlja1RpbWVyID0gc2V0VGltZW91dCh0aGlzLl9yZXNldERvdWJsZUNsaWNrVGltZXIuYmluZCh0aGlzKSwgNTAwKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgYm1hc2sgPSB0aGlzLl90b3VjaEJ1dHRvbjtcbiAgICAgICAgICAgICAgICAvLyBJZiBibWFzayBpcyBzZXRcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXZ0LndoaWNoKSB7XG4gICAgICAgICAgICAgICAgLyogZXZlcnl0aGluZyBleGNlcHQgSUUgKi9cbiAgICAgICAgICAgICAgICBibWFzayA9IDEgPDwgZXZ0LmJ1dHRvbjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLyogSUUgaW5jbHVkaW5nIDkgKi9cbiAgICAgICAgICAgICAgICBibWFzayA9IChldnQuYnV0dG9uICYgMHgxKSArICAgICAgLy8gTGVmdFxuICAgICAgICAgICAgICAgICAgICAgICAgKGV2dC5idXR0b24gJiAweDIpICogMiArICAvLyBSaWdodFxuICAgICAgICAgICAgICAgICAgICAgICAgKGV2dC5idXR0b24gJiAweDQpIC8gMjsgICAvLyBNaWRkbGVcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX29uTW91c2VCdXR0b24pIHtcbiAgICAgICAgICAgICAgICBVdGlsLkRlYnVnKFwib25Nb3VzZUJ1dHRvbiBcIiArIChkb3duID8gXCJkb3duXCIgOiBcInVwXCIpICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIFwiLCB4OiBcIiArIHBvcy54ICsgXCIsIHk6IFwiICsgcG9zLnkgKyBcIiwgYm1hc2s6IFwiICsgYm1hc2spO1xuICAgICAgICAgICAgICAgIHRoaXMuX29uTW91c2VCdXR0b24ocG9zLngsIHBvcy55LCBkb3duLCBibWFzayk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBVdGlsLnN0b3BFdmVudChlKTtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfSxcblxuICAgICAgICBfaGFuZGxlTW91c2VEb3duOiBmdW5jdGlvbiAoZSkge1xuICAgICAgICAgICAgdGhpcy5fY2FwdHVyZU1vdXNlKCk7XG4gICAgICAgICAgICB0aGlzLl9oYW5kbGVNb3VzZUJ1dHRvbihlLCAxKTtcbiAgICAgICAgfSxcblxuICAgICAgICBfaGFuZGxlTW91c2VVcDogZnVuY3Rpb24gKGUpIHtcbiAgICAgICAgICAgIGlmICghdGhpcy5fbW91c2VDYXB0dXJlZCkgeyByZXR1cm47IH1cblxuICAgICAgICAgICAgdGhpcy5faGFuZGxlTW91c2VCdXR0b24oZSwgMCk7XG4gICAgICAgICAgICB0aGlzLl9yZWxlYXNlTW91c2UoKTtcbiAgICAgICAgfSxcblxuICAgICAgICBfaGFuZGxlTW91c2VXaGVlbDogZnVuY3Rpb24gKGUpIHtcbiAgICAgICAgICAgIGlmICghdGhpcy5fZm9jdXNlZCkgeyByZXR1cm4gdHJ1ZTsgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5fbm90aWZ5KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fbm90aWZ5KGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YXIgZXZ0ID0gKGUgPyBlIDogd2luZG93LmV2ZW50KTtcbiAgICAgICAgICAgIHZhciBwb3MgPSBVdGlsLmdldEV2ZW50UG9zaXRpb24oZSwgdGhpcy5fdGFyZ2V0LCB0aGlzLl9zY2FsZSk7XG4gICAgICAgICAgICB2YXIgd2hlZWxEYXRhID0gZXZ0LmRldGFpbCA/IGV2dC5kZXRhaWwgKiAtMSA6IGV2dC53aGVlbERlbHRhIC8gNDA7XG4gICAgICAgICAgICB2YXIgYm1hc2s7XG4gICAgICAgICAgICBpZiAod2hlZWxEYXRhID4gMCkge1xuICAgICAgICAgICAgICAgIGJtYXNrID0gMSA8PCAzO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBibWFzayA9IDEgPDwgNDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX29uTW91c2VCdXR0b24pIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9vbk1vdXNlQnV0dG9uKHBvcy54LCBwb3MueSwgMSwgYm1hc2spO1xuICAgICAgICAgICAgICAgIHRoaXMuX29uTW91c2VCdXR0b24ocG9zLngsIHBvcy55LCAwLCBibWFzayk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBVdGlsLnN0b3BFdmVudChlKTtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfSxcblxuICAgICAgICBfaGFuZGxlTW91c2VNb3ZlOiBmdW5jdGlvbiAoZSkge1xuICAgICAgICAgICAgaWYgKCEgdGhpcy5fZm9jdXNlZCkgeyByZXR1cm4gdHJ1ZTsgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5fbm90aWZ5KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fbm90aWZ5KGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YXIgZXZ0ID0gKGUgPyBlIDogd2luZG93LmV2ZW50KTtcbiAgICAgICAgICAgIHZhciBwb3MgPSBVdGlsLmdldEV2ZW50UG9zaXRpb24oZSwgdGhpcy5fdGFyZ2V0LCB0aGlzLl9zY2FsZSk7XG4gICAgICAgICAgICBpZiAodGhpcy5fb25Nb3VzZU1vdmUpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9vbk1vdXNlTW92ZShwb3MueCwgcG9zLnkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgVXRpbC5zdG9wRXZlbnQoZSk7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2hhbmRsZU1vdXNlRGlzYWJsZTogZnVuY3Rpb24gKGUpIHtcbiAgICAgICAgICAgIGlmICghdGhpcy5fZm9jdXNlZCkgeyByZXR1cm4gdHJ1ZTsgfVxuXG4gICAgICAgICAgICB2YXIgZXZ0ID0gKGUgPyBlIDogd2luZG93LmV2ZW50KTtcbiAgICAgICAgICAgIHZhciBwb3MgPSBVdGlsLmdldEV2ZW50UG9zaXRpb24oZSwgdGhpcy5fdGFyZ2V0LCB0aGlzLl9zY2FsZSk7XG5cbiAgICAgICAgICAgIC8qIFN0b3AgcHJvcGFnYXRpb24gaWYgaW5zaWRlIGNhbnZhcyBhcmVhICovXG4gICAgICAgICAgICBpZiAoKHBvcy5yZWFseCA+PSAwKSAmJiAocG9zLnJlYWx5ID49IDApICYmXG4gICAgICAgICAgICAgICAgKHBvcy5yZWFseCA8IHRoaXMuX3RhcmdldC5vZmZzZXRXaWR0aCkgJiZcbiAgICAgICAgICAgICAgICAocG9zLnJlYWx5IDwgdGhpcy5fdGFyZ2V0Lm9mZnNldEhlaWdodCkpIHtcbiAgICAgICAgICAgICAgICAvL1V0aWwuRGVidWcoXCJtb3VzZSBldmVudCBkaXNhYmxlZFwiKTtcbiAgICAgICAgICAgICAgICBVdGlsLnN0b3BFdmVudChlKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuXG5cbiAgICAgICAgLy8gUHVibGljIG1ldGhvZHNcbiAgICAgICAgZ3JhYjogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdmFyIGMgPSB0aGlzLl90YXJnZXQ7XG5cbiAgICAgICAgICAgIGlmICgnb250b3VjaHN0YXJ0JyBpbiBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBjLmFkZEV2ZW50TGlzdGVuZXIoJ3RvdWNoc3RhcnQnLCB0aGlzLl9ldmVudEhhbmRsZXJzLm1vdXNlZG93bik7XG4gICAgICAgICAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3RvdWNoZW5kJywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZXVwKTtcbiAgICAgICAgICAgICAgICBjLmFkZEV2ZW50TGlzdGVuZXIoJ3RvdWNoZW5kJywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZXVwKTtcbiAgICAgICAgICAgICAgICBjLmFkZEV2ZW50TGlzdGVuZXIoJ3RvdWNobW92ZScsIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2Vtb3ZlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGMuYWRkRXZlbnRMaXN0ZW5lcignbW91c2Vkb3duJywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZWRvd24pO1xuICAgICAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNldXAnLCB0aGlzLl9ldmVudEhhbmRsZXJzLm1vdXNldXApO1xuICAgICAgICAgICAgYy5hZGRFdmVudExpc3RlbmVyKCdtb3VzZXVwJywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZXVwKTtcbiAgICAgICAgICAgIGMuYWRkRXZlbnRMaXN0ZW5lcignbW91c2Vtb3ZlJywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZW1vdmUpO1xuICAgICAgICAgICAgYy5hZGRFdmVudExpc3RlbmVyKChVdGlsLkVuZ2luZS5nZWNrbykgPyAnRE9NTW91c2VTY3JvbGwnIDogJ21vdXNld2hlZWwnLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2V3aGVlbCk7XG5cbiAgICAgICAgICAgIC8qIFdvcmsgYXJvdW5kIHJpZ2h0IGFuZCBtaWRkbGUgY2xpY2sgYnJvd3NlciBiZWhhdmlvcnMgKi9cbiAgICAgICAgICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZWRpc2FibGUpO1xuICAgICAgICAgICAgZG9jdW1lbnQuYm9keS5hZGRFdmVudExpc3RlbmVyKCdjb250ZXh0bWVudScsIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2VkaXNhYmxlKTtcbiAgICAgICAgfSxcblxuICAgICAgICB1bmdyYWI6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHZhciBjID0gdGhpcy5fdGFyZ2V0O1xuXG4gICAgICAgICAgICBpZiAoJ29udG91Y2hzdGFydCcgaW4gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50KSB7XG4gICAgICAgICAgICAgICAgYy5yZW1vdmVFdmVudExpc3RlbmVyKCd0b3VjaHN0YXJ0JywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZWRvd24pO1xuICAgICAgICAgICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCd0b3VjaGVuZCcsIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2V1cCk7XG4gICAgICAgICAgICAgICAgYy5yZW1vdmVFdmVudExpc3RlbmVyKCd0b3VjaGVuZCcsIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2V1cCk7XG4gICAgICAgICAgICAgICAgYy5yZW1vdmVFdmVudExpc3RlbmVyKCd0b3VjaG1vdmUnLCB0aGlzLl9ldmVudEhhbmRsZXJzLm1vdXNlbW92ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ21vdXNlZG93bicsIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2Vkb3duKTtcbiAgICAgICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdtb3VzZXVwJywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZXVwKTtcbiAgICAgICAgICAgIGMucmVtb3ZlRXZlbnRMaXN0ZW5lcignbW91c2V1cCcsIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2V1cCk7XG4gICAgICAgICAgICBjLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ21vdXNlbW92ZScsIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2Vtb3ZlKTtcbiAgICAgICAgICAgIGMucmVtb3ZlRXZlbnRMaXN0ZW5lcigoVXRpbC5FbmdpbmUuZ2Vja28pID8gJ0RPTU1vdXNlU2Nyb2xsJyA6ICdtb3VzZXdoZWVsJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudEhhbmRsZXJzLm1vdXNld2hlZWwpO1xuXG4gICAgICAgICAgICAvKiBXb3JrIGFyb3VuZCByaWdodCBhbmQgbWlkZGxlIGNsaWNrIGJyb3dzZXIgYmVoYXZpb3JzICovXG4gICAgICAgICAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKCdjbGljaycsIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2VkaXNhYmxlKTtcbiAgICAgICAgICAgIGRvY3VtZW50LmJvZHkucmVtb3ZlRXZlbnRMaXN0ZW5lcignY29udGV4dG1lbnUnLCB0aGlzLl9ldmVudEhhbmRsZXJzLm1vdXNlZGlzYWJsZSk7XG5cbiAgICAgICAgfVxuICAgIH07XG5cbiAgICBVdGlsLm1ha2VfcHJvcGVydGllcyhNb3VzZSwgW1xuICAgICAgICBbJ3RhcmdldCcsICAgICAgICAgJ3JvJywgJ2RvbSddLCAgIC8vIERPTSBlbGVtZW50IHRoYXQgY2FwdHVyZXMgbW91c2UgaW5wdXRcbiAgICAgICAgWydub3RpZnknLCAgICAgICAgICdybycsICdmdW5jJ10sICAvLyBGdW5jdGlvbiB0byBjYWxsIHRvIG5vdGlmeSB3aGVuZXZlciBhIG1vdXNlIGV2ZW50IGlzIHJlY2VpdmVkXG4gICAgICAgIFsnZm9jdXNlZCcsICAgICAgICAncncnLCAnYm9vbCddLCAgLy8gQ2FwdHVyZSBhbmQgc2VuZCBtb3VzZSBjbGlja3MvbW92ZW1lbnRcbiAgICAgICAgWydzY2FsZScsICAgICAgICAgICdydycsICdmbG9hdCddLCAvLyBWaWV3cG9ydCBzY2FsZSBmYWN0b3IgMC4wIC0gMS4wXG5cbiAgICAgICAgWydvbk1vdXNlQnV0dG9uJywgICdydycsICdmdW5jJ10sICAvLyBIYW5kbGVyIGZvciBtb3VzZSBidXR0b24gY2xpY2svcmVsZWFzZVxuICAgICAgICBbJ29uTW91c2VNb3ZlJywgICAgJ3J3JywgJ2Z1bmMnXSwgIC8vIEhhbmRsZXIgZm9yIG1vdXNlIG1vdmVtZW50XG4gICAgICAgIFsndG91Y2hCdXR0b24nLCAgICAncncnLCAnaW50J10gICAgLy8gQnV0dG9uIG1hc2sgKDEsIDIsIDQpIGZvciB0b3VjaCBkZXZpY2VzICgwIG1lYW5zIGlnbm9yZSBjbGlja3MpXG4gICAgXSk7XG59KSgpO1xuIl19