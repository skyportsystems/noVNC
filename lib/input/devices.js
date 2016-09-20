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
            } else {
                c.addEventListener('mousedown', this._eventHandlers.mousedown);
                window.addEventListener('mouseup', this._eventHandlers.mouseup);
                c.addEventListener('mouseup', this._eventHandlers.mouseup);
                c.addEventListener('mousemove', this._eventHandlers.mousemove);
                c.addEventListener(_util2.default.Engine.gecko ? 'DOMMouseScroll' : 'mousewheel', this._eventHandlers.mousewheel);
            }

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
            } else {
                c.removeEventListener('mousedown', this._eventHandlers.mousedown);
                window.removeEventListener('mouseup', this._eventHandlers.mouseup);
                c.removeEventListener('mouseup', this._eventHandlers.mouseup);
                c.removeEventListener('mousemove', this._eventHandlers.mousemove);
                c.removeEventListener(_util2.default.Engine.gecko ? 'DOMMouseScroll' : 'mousewheel', this._eventHandlers.mousewheel);
            }

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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImRldmljZXMuanMiXSwibmFtZXMiOlsiS2V5Ym9hcmQiLCJkZWZhdWx0cyIsIl9rZXlEb3duTGlzdCIsInNldF9kZWZhdWx0cyIsImRvY3VtZW50IiwiX2hhbmRsZXIiLCJLZXlFdmVudERlY29kZXIiLCJNb2RpZmllclN5bmMiLCJWZXJpZnlDaGFyTW9kaWZpZXIiLCJUcmFja0tleVN0YXRlIiwiRXNjYXBlTW9kaWZpZXJzIiwiX2hhbmRsZVJmYkV2ZW50IiwiYmluZCIsIl9ldmVudEhhbmRsZXJzIiwiX2hhbmRsZUtleVVwIiwiX2hhbmRsZUtleURvd24iLCJfaGFuZGxlS2V5UHJlc3MiLCJfYWxsS2V5c1VwIiwicHJvdG90eXBlIiwiZSIsIl9vbktleVByZXNzIiwiRGVidWciLCJ0eXBlIiwia2V5c3ltIiwia2V5bmFtZSIsInNldFFFTVVWTkNLZXlib2FyZEhhbmRsZXIiLCJRRU1VS2V5RXZlbnREZWNvZGVyIiwiVHJhY2tRRU1VS2V5U3RhdGUiLCJfZm9jdXNlZCIsImtleWRvd24iLCJzdG9wRXZlbnQiLCJrZXlwcmVzcyIsImtleXVwIiwicmVsZWFzZUFsbCIsImdyYWIiLCJjIiwiX3RhcmdldCIsImFkZEV2ZW50TGlzdGVuZXIiLCJ3aW5kb3ciLCJibHVyIiwidW5ncmFiIiwicmVtb3ZlRXZlbnRMaXN0ZW5lciIsInN5bmMiLCJzeW5jTW9kaWZpZXJzIiwibWFrZV9wcm9wZXJ0aWVzIiwiTW91c2UiLCJfbW91c2VDYXB0dXJlZCIsIl9kb3VibGVDbGlja1RpbWVyIiwiX2xhc3RUb3VjaFBvcyIsIl9oYW5kbGVNb3VzZURvd24iLCJfaGFuZGxlTW91c2VVcCIsIl9oYW5kbGVNb3VzZU1vdmUiLCJfaGFuZGxlTW91c2VXaGVlbCIsIl9oYW5kbGVNb3VzZURpc2FibGUiLCJfY2FwdHVyZU1vdXNlIiwic2V0Q2FwdHVyZSIsIl9yZWxlYXNlTW91c2UiLCJyZWxlYXNlQ2FwdHVyZSIsIl9yZXNldERvdWJsZUNsaWNrVGltZXIiLCJfaGFuZGxlTW91c2VCdXR0b24iLCJkb3duIiwiX25vdGlmeSIsImV2dCIsImV2ZW50IiwicG9zIiwiZ2V0RXZlbnRQb3NpdGlvbiIsIl9zY2FsZSIsImJtYXNrIiwidG91Y2hlcyIsImNoYW5nZWRUb3VjaGVzIiwiY2xlYXJUaW1lb3V0IiwieHMiLCJ4IiwieXMiLCJ5IiwiZCIsIk1hdGgiLCJzcXJ0IiwidGhyZXNob2xkIiwiZGV2aWNlUGl4ZWxSYXRpbyIsInNldFRpbWVvdXQiLCJfdG91Y2hCdXR0b24iLCJ3aGljaCIsImJ1dHRvbiIsIl9vbk1vdXNlQnV0dG9uIiwid2hlZWxEYXRhIiwiZGV0YWlsIiwid2hlZWxEZWx0YSIsIl9vbk1vdXNlTW92ZSIsInJlYWx4IiwicmVhbHkiLCJvZmZzZXRXaWR0aCIsIm9mZnNldEhlaWdodCIsImRvY3VtZW50RWxlbWVudCIsIm1vdXNlZG93biIsIm1vdXNldXAiLCJtb3VzZW1vdmUiLCJFbmdpbmUiLCJnZWNrbyIsIm1vdXNld2hlZWwiLCJtb3VzZWRpc2FibGUiLCJib2R5Il0sIm1hcHBpbmdzIjoiOzs7Ozs7O0FBVUE7Ozs7QUFDQTs7Ozs7O0FBWEE7Ozs7Ozs7QUFPQTtBQUNBOztBQU1PLElBQUlBLHVDQUFKOztBQUVQLENBQUMsWUFBWTtBQUNUOztBQUVBO0FBQ0E7QUFDQTs7QUFFQSxZQVRPQSxRQVNQLGNBQVcsVUFBVUMsUUFBVixFQUFvQjtBQUMzQixhQUFLQyxZQUFMLEdBQW9CLEVBQXBCLENBRDJCLENBQ0s7QUFDQTs7QUFFaEMsdUJBQUtDLFlBQUwsQ0FBa0IsSUFBbEIsRUFBd0JGLFFBQXhCLEVBQWtDO0FBQzlCLHNCQUFVRyxRQURvQjtBQUU5Qix1QkFBVztBQUZtQixTQUFsQzs7QUFLQTtBQUNBLGFBQUtDLFFBQUwsR0FBZ0IsSUFBSSxlQUFhQyxlQUFqQixDQUFpQyxlQUFhQyxZQUFiLEVBQWpDLEVBQ1osZUFBYUMsa0JBQWIsRUFBaUM7QUFDN0IsdUJBQWFDLGFBQWIsQ0FDSSxlQUFhQyxlQUFiLENBQTZCLEtBQUtDLGVBQUwsQ0FBcUJDLElBQXJCLENBQTBC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QUQsRUFBbUIsSUFBbkIsRUFBeUIsS0FBekIsQ0FEd0IsRUFDVztBQUNuQyxLQUFDLFFBQUQsRUFBbUIsSUFBbkIsRUFBeUIsTUFBekIsQ0FGd0IsRUFFVztBQUNuQyxLQUFDLFNBQUQsRUFBbUIsSUFBbkIsRUFBeUIsTUFBekIsQ0FId0IsRUFHVztBQUNuQyxLQUFDLE9BQUQsRUFBbUIsSUFBbkIsRUFBeUIsT0FBekIsQ0FKd0IsRUFJVzs7QUFFbkMsS0FBQyxlQUFELEVBQW1CLElBQW5CLEVBQXlCLE1BQXpCLENBTndCLEVBTVc7QUFDbkMsS0FBQyxhQUFELEVBQW1CLElBQW5CLEVBQXlCLE1BQXpCLENBUHdCLEVBT1c7QUFDbkMsS0FBQyxhQUFELEVBQW1CLElBQW5CLEVBQXlCLEtBQXpCLENBUndCLENBUVc7QUFSWCxLQUE1QjtBQVVILENBN09EIiwiZmlsZSI6ImRldmljZXMuanMiLCJzb3VyY2VzQ29udGVudCI6WyIvKlxuICogbm9WTkM6IEhUTUw1IFZOQyBjbGllbnRcbiAqIENvcHlyaWdodCAoQykgMjAxMiBKb2VsIE1hcnRpblxuICogQ29weXJpZ2h0IChDKSAyMDEzIFNhbXVlbCBNYW5uZWhlZCBmb3IgQ2VuZGlvIEFCXG4gKiBMaWNlbnNlZCB1bmRlciBNUEwgMi4wIG9yIGFueSBsYXRlciB2ZXJzaW9uIChzZWUgTElDRU5TRS50eHQpXG4gKi9cblxuLypqc2xpbnQgYnJvd3NlcjogdHJ1ZSwgd2hpdGU6IGZhbHNlICovXG4vKmdsb2JhbCB3aW5kb3csIFV0aWwgKi9cblxuaW1wb3J0IFV0aWwgZnJvbSBcIi4uL3V0aWxcIjtcbmltcG9ydCBLZXlib2FyZFV0aWwgZnJvbSBcIi4vdXRpbFwiO1xuXG5cbmV4cG9ydCB2YXIgS2V5Ym9hcmQ7XG5cbihmdW5jdGlvbiAoKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG5cbiAgICAvL1xuICAgIC8vIEtleWJvYXJkIGV2ZW50IGhhbmRsZXJcbiAgICAvL1xuXG4gICAgS2V5Ym9hcmQgPSBmdW5jdGlvbiAoZGVmYXVsdHMpIHtcbiAgICAgICAgdGhpcy5fa2V5RG93bkxpc3QgPSBbXTsgICAgICAgICAvLyBMaXN0IG9mIGRlcHJlc3NlZCBrZXlzXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gKGV2ZW4gaWYgdGhleSBhcmUgaGFwcHkpXG5cbiAgICAgICAgVXRpbC5zZXRfZGVmYXVsdHModGhpcywgZGVmYXVsdHMsIHtcbiAgICAgICAgICAgICd0YXJnZXQnOiBkb2N1bWVudCxcbiAgICAgICAgICAgICdmb2N1c2VkJzogdHJ1ZVxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBjcmVhdGUgdGhlIGtleWJvYXJkIGhhbmRsZXJcbiAgICAgICAgdGhpcy5faGFuZGxlciA9IG5ldyBLZXlib2FyZFV0aWwuS2V5RXZlbnREZWNvZGVyKEtleWJvYXJkVXRpbC5Nb2RpZmllclN5bmMoKSxcbiAgICAgICAgICAgIEtleWJvYXJkVXRpbC5WZXJpZnlDaGFyTW9kaWZpZXIoIC8qIGpzaGludCBuZXdjYXA6IGZhbHNlICovXG4gICAgICAgICAgICAgICAgS2V5Ym9hcmRVdGlsLlRyYWNrS2V5U3RhdGUoXG4gICAgICAgICAgICAgICAgICAgIEtleWJvYXJkVXRpbC5Fc2NhcGVNb2RpZmllcnModGhpcy5faGFuZGxlUmZiRXZlbnQuYmluZCh0aGlzKSlcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICApXG4gICAgICAgICk7IC8qIGpzaGludCBuZXdjYXA6IHRydWUgKi9cblxuICAgICAgICAvLyBrZWVwIHRoZXNlIGhlcmUgc28gd2UgY2FuIHJlZmVyIHRvIHRoZW0gbGF0ZXJcbiAgICAgICAgdGhpcy5fZXZlbnRIYW5kbGVycyA9IHtcbiAgICAgICAgICAgICdrZXl1cCc6IHRoaXMuX2hhbmRsZUtleVVwLmJpbmQodGhpcyksXG4gICAgICAgICAgICAna2V5ZG93bic6IHRoaXMuX2hhbmRsZUtleURvd24uYmluZCh0aGlzKSxcbiAgICAgICAgICAgICdrZXlwcmVzcyc6IHRoaXMuX2hhbmRsZUtleVByZXNzLmJpbmQodGhpcyksXG4gICAgICAgICAgICAnYmx1cic6IHRoaXMuX2FsbEtleXNVcC5iaW5kKHRoaXMpXG4gICAgICAgIH07XG4gICAgfTtcblxuICAgIEtleWJvYXJkLnByb3RvdHlwZSA9IHtcbiAgICAgICAgLy8gcHJpdmF0ZSBtZXRob2RzXG5cbiAgICAgICAgX2hhbmRsZVJmYkV2ZW50OiBmdW5jdGlvbiAoZSkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX29uS2V5UHJlc3MpIHtcbiAgICAgICAgICAgICAgICBVdGlsLkRlYnVnKFwib25LZXlQcmVzcyBcIiArIChlLnR5cGUgPT0gJ2tleWRvd24nID8gXCJkb3duXCIgOiBcInVwXCIpICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIFwiLCBrZXlzeW06IFwiICsgZS5rZXlzeW0ua2V5c3ltICsgXCIoXCIgKyBlLmtleXN5bS5rZXluYW1lICsgXCIpXCIpO1xuICAgICAgICAgICAgICAgIHRoaXMuX29uS2V5UHJlc3MoZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgc2V0UUVNVVZOQ0tleWJvYXJkSGFuZGxlcjogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdGhpcy5faGFuZGxlciA9IG5ldyBLZXlib2FyZFV0aWwuUUVNVUtleUV2ZW50RGVjb2RlcihLZXlib2FyZFV0aWwuTW9kaWZpZXJTeW5jKCksXG4gICAgICAgICAgICAgICAgS2V5Ym9hcmRVdGlsLlRyYWNrUUVNVUtleVN0YXRlKFxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9oYW5kbGVSZmJFdmVudC5iaW5kKHRoaXMpXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfSxcblxuICAgICAgICBfaGFuZGxlS2V5RG93bjogZnVuY3Rpb24gKGUpIHtcbiAgICAgICAgICAgIGlmICghdGhpcy5fZm9jdXNlZCkgeyByZXR1cm4gdHJ1ZTsgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5faGFuZGxlci5rZXlkb3duKGUpKSB7XG4gICAgICAgICAgICAgICAgLy8gU3VwcHJlc3MgYnViYmxpbmcvZGVmYXVsdCBhY3Rpb25zXG4gICAgICAgICAgICAgICAgVXRpbC5zdG9wRXZlbnQoZSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBBbGxvdyB0aGUgZXZlbnQgdG8gYnViYmxlIGFuZCBiZWNvbWUgYSBrZXlQcmVzcyBldmVudCB3aGljaFxuICAgICAgICAgICAgICAgIC8vIHdpbGwgaGF2ZSB0aGUgY2hhcmFjdGVyIGNvZGUgdHJhbnNsYXRlZFxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIF9oYW5kbGVLZXlQcmVzczogZnVuY3Rpb24gKGUpIHtcbiAgICAgICAgICAgIGlmICghdGhpcy5fZm9jdXNlZCkgeyByZXR1cm4gdHJ1ZTsgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5faGFuZGxlci5rZXlwcmVzcyhlKSkge1xuICAgICAgICAgICAgICAgIC8vIFN1cHByZXNzIGJ1YmJsaW5nL2RlZmF1bHQgYWN0aW9uc1xuICAgICAgICAgICAgICAgIFV0aWwuc3RvcEV2ZW50KGUpO1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gQWxsb3cgdGhlIGV2ZW50IHRvIGJ1YmJsZSBhbmQgYmVjb21lIGEga2V5UHJlc3MgZXZlbnQgd2hpY2hcbiAgICAgICAgICAgICAgICAvLyB3aWxsIGhhdmUgdGhlIGNoYXJhY3RlciBjb2RlIHRyYW5zbGF0ZWRcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBfaGFuZGxlS2V5VXA6IGZ1bmN0aW9uIChlKSB7XG4gICAgICAgICAgICBpZiAoIXRoaXMuX2ZvY3VzZWQpIHsgcmV0dXJuIHRydWU7IH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX2hhbmRsZXIua2V5dXAoZSkpIHtcbiAgICAgICAgICAgICAgICAvLyBTdXBwcmVzcyBidWJibGluZy9kZWZhdWx0IGFjdGlvbnNcbiAgICAgICAgICAgICAgICBVdGlsLnN0b3BFdmVudChlKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIEFsbG93IHRoZSBldmVudCB0byBidWJibGUgYW5kIGJlY29tZSBhIGtleVByZXNzIGV2ZW50IHdoaWNoXG4gICAgICAgICAgICAgICAgLy8gd2lsbCBoYXZlIHRoZSBjaGFyYWN0ZXIgY29kZSB0cmFuc2xhdGVkXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2FsbEtleXNVcDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIj4+IEtleWJvYXJkLmFsbEtleXNVcFwiKTtcbiAgICAgICAgICAgIHRoaXMuX2hhbmRsZXIucmVsZWFzZUFsbCgpO1xuICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIjw8IEtleWJvYXJkLmFsbEtleXNVcFwiKTtcbiAgICAgICAgfSxcblxuICAgICAgICAvLyBQdWJsaWMgbWV0aG9kc1xuXG4gICAgICAgIGdyYWI6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIC8vVXRpbC5EZWJ1ZyhcIj4+IEtleWJvYXJkLmdyYWJcIik7XG4gICAgICAgICAgICB2YXIgYyA9IHRoaXMuX3RhcmdldDtcblxuICAgICAgICAgICAgYy5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgdGhpcy5fZXZlbnRIYW5kbGVycy5rZXlkb3duKTtcbiAgICAgICAgICAgIGMuYWRkRXZlbnRMaXN0ZW5lcigna2V5dXAnLCB0aGlzLl9ldmVudEhhbmRsZXJzLmtleXVwKTtcbiAgICAgICAgICAgIGMuYWRkRXZlbnRMaXN0ZW5lcigna2V5cHJlc3MnLCB0aGlzLl9ldmVudEhhbmRsZXJzLmtleXByZXNzKTtcblxuICAgICAgICAgICAgLy8gUmVsZWFzZSAoa2V5IHVwKSBpZiB3aW5kb3cgbG9zZXMgZm9jdXNcbiAgICAgICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdibHVyJywgdGhpcy5fZXZlbnRIYW5kbGVycy5ibHVyKTtcblxuICAgICAgICAgICAgLy9VdGlsLkRlYnVnKFwiPDwgS2V5Ym9hcmQuZ3JhYlwiKTtcbiAgICAgICAgfSxcblxuICAgICAgICB1bmdyYWI6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIC8vVXRpbC5EZWJ1ZyhcIj4+IEtleWJvYXJkLnVuZ3JhYlwiKTtcbiAgICAgICAgICAgIHZhciBjID0gdGhpcy5fdGFyZ2V0O1xuXG4gICAgICAgICAgICBjLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCB0aGlzLl9ldmVudEhhbmRsZXJzLmtleWRvd24pO1xuICAgICAgICAgICAgYy5yZW1vdmVFdmVudExpc3RlbmVyKCdrZXl1cCcsIHRoaXMuX2V2ZW50SGFuZGxlcnMua2V5dXApO1xuICAgICAgICAgICAgYy5yZW1vdmVFdmVudExpc3RlbmVyKCdrZXlwcmVzcycsIHRoaXMuX2V2ZW50SGFuZGxlcnMua2V5cHJlc3MpO1xuICAgICAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2JsdXInLCB0aGlzLl9ldmVudEhhbmRsZXJzLmJsdXIpO1xuXG4gICAgICAgICAgICAvLyBSZWxlYXNlIChrZXkgdXApIGFsbCBrZXlzIHRoYXQgYXJlIGluIGEgZG93biBzdGF0ZVxuICAgICAgICAgICAgdGhpcy5fYWxsS2V5c1VwKCk7XG5cbiAgICAgICAgICAgIC8vVXRpbC5EZWJ1ZyhcIj4+IEtleWJvYXJkLnVuZ3JhYlwiKTtcbiAgICAgICAgfSxcblxuICAgICAgICBzeW5jOiBmdW5jdGlvbiAoZSkge1xuICAgICAgICAgICAgdGhpcy5faGFuZGxlci5zeW5jTW9kaWZpZXJzKGUpO1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIFV0aWwubWFrZV9wcm9wZXJ0aWVzKEtleWJvYXJkLCBbXG4gICAgICAgIFsndGFyZ2V0JywgICAgICd3bycsICdkb20nXSwgIC8vIERPTSBlbGVtZW50IHRoYXQgY2FwdHVyZXMga2V5Ym9hcmQgaW5wdXRcbiAgICAgICAgWydmb2N1c2VkJywgICAgJ3J3JywgJ2Jvb2wnXSwgLy8gQ2FwdHVyZSBhbmQgc2VuZCBrZXkgZXZlbnRzXG5cbiAgICAgICAgWydvbktleVByZXNzJywgJ3J3JywgJ2Z1bmMnXSAvLyBIYW5kbGVyIGZvciBrZXkgcHJlc3MvcmVsZWFzZVxuICAgIF0pO1xufSkoKTtcblxuZXhwb3J0IHZhciBNb3VzZTtcblxuKGZ1bmN0aW9uICgpIHtcbiAgICBNb3VzZSA9IGZ1bmN0aW9uIChkZWZhdWx0cykge1xuICAgICAgICB0aGlzLl9tb3VzZUNhcHR1cmVkICA9IGZhbHNlO1xuXG4gICAgICAgIHRoaXMuX2RvdWJsZUNsaWNrVGltZXIgPSBudWxsO1xuICAgICAgICB0aGlzLl9sYXN0VG91Y2hQb3MgPSBudWxsO1xuXG4gICAgICAgIC8vIENvbmZpZ3VyYXRpb24gYXR0cmlidXRlc1xuICAgICAgICBVdGlsLnNldF9kZWZhdWx0cyh0aGlzLCBkZWZhdWx0cywge1xuICAgICAgICAgICAgJ3RhcmdldCc6IGRvY3VtZW50LFxuICAgICAgICAgICAgJ2ZvY3VzZWQnOiB0cnVlLFxuICAgICAgICAgICAgJ3NjYWxlJzogMS4wLFxuICAgICAgICAgICAgJ3RvdWNoQnV0dG9uJzogMVxuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLl9ldmVudEhhbmRsZXJzID0ge1xuICAgICAgICAgICAgJ21vdXNlZG93bic6IHRoaXMuX2hhbmRsZU1vdXNlRG93bi5iaW5kKHRoaXMpLFxuICAgICAgICAgICAgJ21vdXNldXAnOiB0aGlzLl9oYW5kbGVNb3VzZVVwLmJpbmQodGhpcyksXG4gICAgICAgICAgICAnbW91c2Vtb3ZlJzogdGhpcy5faGFuZGxlTW91c2VNb3ZlLmJpbmQodGhpcyksXG4gICAgICAgICAgICAnbW91c2V3aGVlbCc6IHRoaXMuX2hhbmRsZU1vdXNlV2hlZWwuYmluZCh0aGlzKSxcbiAgICAgICAgICAgICdtb3VzZWRpc2FibGUnOiB0aGlzLl9oYW5kbGVNb3VzZURpc2FibGUuYmluZCh0aGlzKVxuICAgICAgICB9O1xuICAgIH07XG5cbiAgICBNb3VzZS5wcm90b3R5cGUgPSB7XG4gICAgICAgIC8vIHByaXZhdGUgbWV0aG9kc1xuICAgICAgICBfY2FwdHVyZU1vdXNlOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAvLyBjYXB0dXJpbmcgdGhlIG1vdXNlIGVuc3VyZXMgd2UgZ2V0IHRoZSBtb3VzZXVwIGV2ZW50XG4gICAgICAgICAgICBpZiAodGhpcy5fdGFyZ2V0LnNldENhcHR1cmUpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl90YXJnZXQuc2V0Q2FwdHVyZSgpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBzb21lIGJyb3dzZXJzIGdpdmUgdXMgbW91c2V1cCBldmVudHMgcmVnYXJkbGVzcyxcbiAgICAgICAgICAgIC8vIHNvIGlmIHdlIG5ldmVyIGNhcHR1cmVkIHRoZSBtb3VzZSwgd2UgY2FuIGRpc3JlZ2FyZCB0aGUgZXZlbnRcbiAgICAgICAgICAgIHRoaXMuX21vdXNlQ2FwdHVyZWQgPSB0cnVlO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9yZWxlYXNlTW91c2U6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl90YXJnZXQucmVsZWFzZUNhcHR1cmUpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl90YXJnZXQucmVsZWFzZUNhcHR1cmUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMuX21vdXNlQ2FwdHVyZWQgPSBmYWxzZTtcbiAgICAgICAgfSxcblxuICAgICAgICBfcmVzZXREb3VibGVDbGlja1RpbWVyOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICB0aGlzLl9kb3VibGVDbGlja1RpbWVyID0gbnVsbDtcbiAgICAgICAgfSxcblxuICAgICAgICBfaGFuZGxlTW91c2VCdXR0b246IGZ1bmN0aW9uIChlLCBkb3duKSB7XG4gICAgICAgICAgICBpZiAoIXRoaXMuX2ZvY3VzZWQpIHsgcmV0dXJuIHRydWU7IH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX25vdGlmeSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX25vdGlmeShlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFyIGV2dCA9IChlID8gZSA6IHdpbmRvdy5ldmVudCk7XG4gICAgICAgICAgICB2YXIgcG9zID0gVXRpbC5nZXRFdmVudFBvc2l0aW9uKGUsIHRoaXMuX3RhcmdldCwgdGhpcy5fc2NhbGUpO1xuXG4gICAgICAgICAgICB2YXIgYm1hc2s7XG4gICAgICAgICAgICBpZiAoZS50b3VjaGVzIHx8IGUuY2hhbmdlZFRvdWNoZXMpIHtcbiAgICAgICAgICAgICAgICAvLyBUb3VjaCBkZXZpY2VcblxuICAgICAgICAgICAgICAgIC8vIFdoZW4gdHdvIHRvdWNoZXMgb2NjdXIgd2l0aGluIDUwMCBtcyBvZiBlYWNoIG90aGVyIGFuZCBhcmVcbiAgICAgICAgICAgICAgICAvLyBjbG9zZSBlbm91Z2ggdG9nZXRoZXIgYSBkb3VibGUgY2xpY2sgaXMgdHJpZ2dlcmVkLlxuICAgICAgICAgICAgICAgIGlmIChkb3duID09IDEpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX2RvdWJsZUNsaWNrVGltZXIgPT09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2xhc3RUb3VjaFBvcyA9IHBvcztcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aGlzLl9kb3VibGVDbGlja1RpbWVyKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gV2hlbiB0aGUgZGlzdGFuY2UgYmV0d2VlbiB0aGUgdHdvIHRvdWNoZXMgaXMgc21hbGwgZW5vdWdoXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBmb3JjZSB0aGUgcG9zaXRpb24gb2YgdGhlIGxhdHRlciB0b3VjaCB0byB0aGUgcG9zaXRpb24gb2ZcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIHRoZSBmaXJzdC5cblxuICAgICAgICAgICAgICAgICAgICAgICAgdmFyIHhzID0gdGhpcy5fbGFzdFRvdWNoUG9zLnggLSBwb3MueDtcbiAgICAgICAgICAgICAgICAgICAgICAgIHZhciB5cyA9IHRoaXMuX2xhc3RUb3VjaFBvcy55IC0gcG9zLnk7XG4gICAgICAgICAgICAgICAgICAgICAgICB2YXIgZCA9IE1hdGguc3FydCgoeHMgKiB4cykgKyAoeXMgKiB5cykpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBUaGUgZ29hbCBpcyB0byB0cmlnZ2VyIG9uIGEgY2VydGFpbiBwaHlzaWNhbCB3aWR0aCwgdGhlXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBkZXZpY2VQaXhlbFJhdGlvIGJyaW5ncyB1cyBhIGJpdCBjbG9zZXIgYnV0IGlzIG5vdCBvcHRpbWFsLlxuICAgICAgICAgICAgICAgICAgICAgICAgdmFyIHRocmVzaG9sZCA9IDIwICogKHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvIHx8IDEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGQgPCB0aHJlc2hvbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwb3MgPSB0aGlzLl9sYXN0VG91Y2hQb3M7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fZG91YmxlQ2xpY2tUaW1lciA9IHNldFRpbWVvdXQodGhpcy5fcmVzZXREb3VibGVDbGlja1RpbWVyLmJpbmQodGhpcyksIDUwMCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGJtYXNrID0gdGhpcy5fdG91Y2hCdXR0b247XG4gICAgICAgICAgICAgICAgLy8gSWYgYm1hc2sgaXMgc2V0XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGV2dC53aGljaCkge1xuICAgICAgICAgICAgICAgIC8qIGV2ZXJ5dGhpbmcgZXhjZXB0IElFICovXG4gICAgICAgICAgICAgICAgYm1hc2sgPSAxIDw8IGV2dC5idXR0b247XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8qIElFIGluY2x1ZGluZyA5ICovXG4gICAgICAgICAgICAgICAgYm1hc2sgPSAoZXZ0LmJ1dHRvbiAmIDB4MSkgKyAgICAgIC8vIExlZnRcbiAgICAgICAgICAgICAgICAgICAgICAgIChldnQuYnV0dG9uICYgMHgyKSAqIDIgKyAgLy8gUmlnaHRcbiAgICAgICAgICAgICAgICAgICAgICAgIChldnQuYnV0dG9uICYgMHg0KSAvIDI7ICAgLy8gTWlkZGxlXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9vbk1vdXNlQnV0dG9uKSB7XG4gICAgICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIm9uTW91c2VCdXR0b24gXCIgKyAoZG93biA/IFwiZG93blwiIDogXCJ1cFwiKSArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICBcIiwgeDogXCIgKyBwb3MueCArIFwiLCB5OiBcIiArIHBvcy55ICsgXCIsIGJtYXNrOiBcIiArIGJtYXNrKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9vbk1vdXNlQnV0dG9uKHBvcy54LCBwb3MueSwgZG93biwgYm1hc2spO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgVXRpbC5zdG9wRXZlbnQoZSk7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2hhbmRsZU1vdXNlRG93bjogZnVuY3Rpb24gKGUpIHtcbiAgICAgICAgICAgIHRoaXMuX2NhcHR1cmVNb3VzZSgpO1xuICAgICAgICAgICAgdGhpcy5faGFuZGxlTW91c2VCdXR0b24oZSwgMSk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2hhbmRsZU1vdXNlVXA6IGZ1bmN0aW9uIChlKSB7XG4gICAgICAgICAgICBpZiAoIXRoaXMuX21vdXNlQ2FwdHVyZWQpIHsgcmV0dXJuOyB9XG5cbiAgICAgICAgICAgIHRoaXMuX2hhbmRsZU1vdXNlQnV0dG9uKGUsIDApO1xuICAgICAgICAgICAgdGhpcy5fcmVsZWFzZU1vdXNlKCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2hhbmRsZU1vdXNlV2hlZWw6IGZ1bmN0aW9uIChlKSB7XG4gICAgICAgICAgICBpZiAoIXRoaXMuX2ZvY3VzZWQpIHsgcmV0dXJuIHRydWU7IH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX25vdGlmeSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX25vdGlmeShlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFyIGV2dCA9IChlID8gZSA6IHdpbmRvdy5ldmVudCk7XG4gICAgICAgICAgICB2YXIgcG9zID0gVXRpbC5nZXRFdmVudFBvc2l0aW9uKGUsIHRoaXMuX3RhcmdldCwgdGhpcy5fc2NhbGUpO1xuICAgICAgICAgICAgdmFyIHdoZWVsRGF0YSA9IGV2dC5kZXRhaWwgPyBldnQuZGV0YWlsICogLTEgOiBldnQud2hlZWxEZWx0YSAvIDQwO1xuICAgICAgICAgICAgdmFyIGJtYXNrO1xuICAgICAgICAgICAgaWYgKHdoZWVsRGF0YSA+IDApIHtcbiAgICAgICAgICAgICAgICBibWFzayA9IDEgPDwgMztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYm1hc2sgPSAxIDw8IDQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9vbk1vdXNlQnV0dG9uKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fb25Nb3VzZUJ1dHRvbihwb3MueCwgcG9zLnksIDEsIGJtYXNrKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9vbk1vdXNlQnV0dG9uKHBvcy54LCBwb3MueSwgMCwgYm1hc2spO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgVXRpbC5zdG9wRXZlbnQoZSk7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2hhbmRsZU1vdXNlTW92ZTogZnVuY3Rpb24gKGUpIHtcbiAgICAgICAgICAgIGlmICghIHRoaXMuX2ZvY3VzZWQpIHsgcmV0dXJuIHRydWU7IH1cblxuICAgICAgICAgICAgaWYgKHRoaXMuX25vdGlmeSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX25vdGlmeShlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFyIGV2dCA9IChlID8gZSA6IHdpbmRvdy5ldmVudCk7XG4gICAgICAgICAgICB2YXIgcG9zID0gVXRpbC5nZXRFdmVudFBvc2l0aW9uKGUsIHRoaXMuX3RhcmdldCwgdGhpcy5fc2NhbGUpO1xuICAgICAgICAgICAgaWYgKHRoaXMuX29uTW91c2VNb3ZlKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fb25Nb3VzZU1vdmUocG9zLngsIHBvcy55KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFV0aWwuc3RvcEV2ZW50KGUpO1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9oYW5kbGVNb3VzZURpc2FibGU6IGZ1bmN0aW9uIChlKSB7XG4gICAgICAgICAgICBpZiAoIXRoaXMuX2ZvY3VzZWQpIHsgcmV0dXJuIHRydWU7IH1cblxuICAgICAgICAgICAgdmFyIGV2dCA9IChlID8gZSA6IHdpbmRvdy5ldmVudCk7XG4gICAgICAgICAgICB2YXIgcG9zID0gVXRpbC5nZXRFdmVudFBvc2l0aW9uKGUsIHRoaXMuX3RhcmdldCwgdGhpcy5fc2NhbGUpO1xuXG4gICAgICAgICAgICAvKiBTdG9wIHByb3BhZ2F0aW9uIGlmIGluc2lkZSBjYW52YXMgYXJlYSAqL1xuICAgICAgICAgICAgaWYgKChwb3MucmVhbHggPj0gMCkgJiYgKHBvcy5yZWFseSA+PSAwKSAmJlxuICAgICAgICAgICAgICAgIChwb3MucmVhbHggPCB0aGlzLl90YXJnZXQub2Zmc2V0V2lkdGgpICYmXG4gICAgICAgICAgICAgICAgKHBvcy5yZWFseSA8IHRoaXMuX3RhcmdldC5vZmZzZXRIZWlnaHQpKSB7XG4gICAgICAgICAgICAgICAgLy9VdGlsLkRlYnVnKFwibW91c2UgZXZlbnQgZGlzYWJsZWRcIik7XG4gICAgICAgICAgICAgICAgVXRpbC5zdG9wRXZlbnQoZSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcblxuXG4gICAgICAgIC8vIFB1YmxpYyBtZXRob2RzXG4gICAgICAgIGdyYWI6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHZhciBjID0gdGhpcy5fdGFyZ2V0O1xuXG4gICAgICAgICAgICBpZiAoJ29udG91Y2hzdGFydCcgaW4gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50KSB7XG4gICAgICAgICAgICAgICAgYy5hZGRFdmVudExpc3RlbmVyKCd0b3VjaHN0YXJ0JywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZWRvd24pO1xuICAgICAgICAgICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCd0b3VjaGVuZCcsIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2V1cCk7XG4gICAgICAgICAgICAgICAgYy5hZGRFdmVudExpc3RlbmVyKCd0b3VjaGVuZCcsIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2V1cCk7XG4gICAgICAgICAgICAgICAgYy5hZGRFdmVudExpc3RlbmVyKCd0b3VjaG1vdmUnLCB0aGlzLl9ldmVudEhhbmRsZXJzLm1vdXNlbW92ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGMuYWRkRXZlbnRMaXN0ZW5lcignbW91c2Vkb3duJywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZWRvd24pO1xuICAgICAgICAgICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdtb3VzZXVwJywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZXVwKTtcbiAgICAgICAgICAgICAgICBjLmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNldXAnLCB0aGlzLl9ldmVudEhhbmRsZXJzLm1vdXNldXApO1xuICAgICAgICAgICAgICAgIGMuYWRkRXZlbnRMaXN0ZW5lcignbW91c2Vtb3ZlJywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZW1vdmUpO1xuICAgICAgICAgICAgICAgIGMuYWRkRXZlbnRMaXN0ZW5lcigoVXRpbC5FbmdpbmUuZ2Vja28pID8gJ0RPTU1vdXNlU2Nyb2xsJyA6ICdtb3VzZXdoZWVsJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2V3aGVlbCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qIFdvcmsgYXJvdW5kIHJpZ2h0IGFuZCBtaWRkbGUgY2xpY2sgYnJvd3NlciBiZWhhdmlvcnMgKi9cbiAgICAgICAgICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZWRpc2FibGUpO1xuICAgICAgICAgICAgZG9jdW1lbnQuYm9keS5hZGRFdmVudExpc3RlbmVyKCdjb250ZXh0bWVudScsIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2VkaXNhYmxlKTtcbiAgICAgICAgfSxcblxuICAgICAgICB1bmdyYWI6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHZhciBjID0gdGhpcy5fdGFyZ2V0O1xuXG4gICAgICAgICAgICBpZiAoJ29udG91Y2hzdGFydCcgaW4gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50KSB7XG4gICAgICAgICAgICAgICAgYy5yZW1vdmVFdmVudExpc3RlbmVyKCd0b3VjaHN0YXJ0JywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZWRvd24pO1xuICAgICAgICAgICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCd0b3VjaGVuZCcsIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2V1cCk7XG4gICAgICAgICAgICAgICAgYy5yZW1vdmVFdmVudExpc3RlbmVyKCd0b3VjaGVuZCcsIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2V1cCk7XG4gICAgICAgICAgICAgICAgYy5yZW1vdmVFdmVudExpc3RlbmVyKCd0b3VjaG1vdmUnLCB0aGlzLl9ldmVudEhhbmRsZXJzLm1vdXNlbW92ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGMucmVtb3ZlRXZlbnRMaXN0ZW5lcignbW91c2Vkb3duJywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZWRvd24pO1xuICAgICAgICAgICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdtb3VzZXVwJywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZXVwKTtcbiAgICAgICAgICAgICAgICBjLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ21vdXNldXAnLCB0aGlzLl9ldmVudEhhbmRsZXJzLm1vdXNldXApO1xuICAgICAgICAgICAgICAgIGMucmVtb3ZlRXZlbnRMaXN0ZW5lcignbW91c2Vtb3ZlJywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZW1vdmUpO1xuICAgICAgICAgICAgICAgIGMucmVtb3ZlRXZlbnRMaXN0ZW5lcigoVXRpbC5FbmdpbmUuZ2Vja28pID8gJ0RPTU1vdXNlU2Nyb2xsJyA6ICdtb3VzZXdoZWVsJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2V3aGVlbCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qIFdvcmsgYXJvdW5kIHJpZ2h0IGFuZCBtaWRkbGUgY2xpY2sgYnJvd3NlciBiZWhhdmlvcnMgKi9cbiAgICAgICAgICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgdGhpcy5fZXZlbnRIYW5kbGVycy5tb3VzZWRpc2FibGUpO1xuICAgICAgICAgICAgZG9jdW1lbnQuYm9keS5yZW1vdmVFdmVudExpc3RlbmVyKCdjb250ZXh0bWVudScsIHRoaXMuX2V2ZW50SGFuZGxlcnMubW91c2VkaXNhYmxlKTtcblxuICAgICAgICB9XG4gICAgfTtcblxuICAgIFV0aWwubWFrZV9wcm9wZXJ0aWVzKE1vdXNlLCBbXG4gICAgICAgIFsndGFyZ2V0JywgICAgICAgICAncm8nLCAnZG9tJ10sICAgLy8gRE9NIGVsZW1lbnQgdGhhdCBjYXB0dXJlcyBtb3VzZSBpbnB1dFxuICAgICAgICBbJ25vdGlmeScsICAgICAgICAgJ3JvJywgJ2Z1bmMnXSwgIC8vIEZ1bmN0aW9uIHRvIGNhbGwgdG8gbm90aWZ5IHdoZW5ldmVyIGEgbW91c2UgZXZlbnQgaXMgcmVjZWl2ZWRcbiAgICAgICAgWydmb2N1c2VkJywgICAgICAgICdydycsICdib29sJ10sICAvLyBDYXB0dXJlIGFuZCBzZW5kIG1vdXNlIGNsaWNrcy9tb3ZlbWVudFxuICAgICAgICBbJ3NjYWxlJywgICAgICAgICAgJ3J3JywgJ2Zsb2F0J10sIC8vIFZpZXdwb3J0IHNjYWxlIGZhY3RvciAwLjAgLSAxLjBcblxuICAgICAgICBbJ29uTW91c2VCdXR0b24nLCAgJ3J3JywgJ2Z1bmMnXSwgIC8vIEhhbmRsZXIgZm9yIG1vdXNlIGJ1dHRvbiBjbGljay9yZWxlYXNlXG4gICAgICAgIFsnb25Nb3VzZU1vdmUnLCAgICAncncnLCAnZnVuYyddLCAgLy8gSGFuZGxlciBmb3IgbW91c2UgbW92ZW1lbnRcbiAgICAgICAgWyd0b3VjaEJ1dHRvbicsICAgICdydycsICdpbnQnXSAgICAvLyBCdXR0b24gbWFzayAoMSwgMiwgNCkgZm9yIHRvdWNoIGRldmljZXMgKDAgbWVhbnMgaWdub3JlIGNsaWNrcylcbiAgICBdKTtcbn0pKCk7XG4iXX0=