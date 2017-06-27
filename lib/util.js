'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});
/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2012 Joel Martin
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 */

/* jshint white: false, nonstandard: true */
/*global window, console, document, navigator, ActiveXObject, INCLUDE_URI */

var Util = {};

/*
 * ------------------------------------------------------
 * Namespaced in Util
 * ------------------------------------------------------
 */

/*
 * Logging/debug routines
 */

Util._log_level = 'warn';
Util.init_logging = function (level) {
    "use strict";

    if (typeof level === 'undefined') {
        level = Util._log_level;
    } else {
        Util._log_level = level;
    }

    Util.Debug = Util.Info = Util.Warn = Util.Error = function (msg) {};
    if (typeof window.console !== "undefined") {
        /* jshint -W086 */
        switch (level) {
            case 'debug':
                Util.Debug = function (msg) {
                    console.log(msg);
                };
            case 'info':
                Util.Info = function (msg) {
                    console.info(msg);
                };
            case 'warn':
                Util.Warn = function (msg) {
                    console.warn(msg);
                };
            case 'error':
                Util.Error = function (msg) {
                    console.error(msg);
                };
            case 'none':
                break;
            default:
                throw new Error("invalid logging type '" + level + "'");
        }
        /* jshint +W086 */
    }
};
Util.get_logging = function () {
    return Util._log_level;
};
// Initialize logging level
Util.init_logging();

Util.make_property = function (proto, name, mode, type) {
    "use strict";

    var getter;
    if (type === 'arr') {
        getter = function (idx) {
            if (typeof idx !== 'undefined') {
                return this['_' + name][idx];
            } else {
                return this['_' + name];
            }
        };
    } else {
        getter = function () {
            return this['_' + name];
        };
    }

    var make_setter = function (process_val) {
        if (process_val) {
            return function (val, idx) {
                if (typeof idx !== 'undefined') {
                    this['_' + name][idx] = process_val(val);
                } else {
                    this['_' + name] = process_val(val);
                }
            };
        } else {
            return function (val, idx) {
                if (typeof idx !== 'undefined') {
                    this['_' + name][idx] = val;
                } else {
                    this['_' + name] = val;
                }
            };
        }
    };

    var setter;
    if (type === 'bool') {
        setter = make_setter(function (val) {
            if (!val || val in { '0': 1, 'no': 1, 'false': 1 }) {
                return false;
            } else {
                return true;
            }
        });
    } else if (type === 'int') {
        setter = make_setter(function (val) {
            return parseInt(val, 10);
        });
    } else if (type === 'float') {
        setter = make_setter(parseFloat);
    } else if (type === 'str') {
        setter = make_setter(String);
    } else if (type === 'func') {
        setter = make_setter(function (val) {
            if (!val) {
                return function () {};
            } else {
                return val;
            }
        });
    } else if (type === 'arr' || type === 'dom' || type == 'raw') {
        setter = make_setter();
    } else {
        throw new Error('Unknown property type ' + type); // some sanity checking
    }

    // set the getter
    if (typeof proto['get_' + name] === 'undefined') {
        proto['get_' + name] = getter;
    }

    // set the setter if needed
    if (typeof proto['set_' + name] === 'undefined') {
        if (mode === 'rw') {
            proto['set_' + name] = setter;
        } else if (mode === 'wo') {
            proto['set_' + name] = function (val, idx) {
                if (typeof this['_' + name] !== 'undefined') {
                    throw new Error(name + " can only be set once");
                }
                setter.call(this, val, idx);
            };
        }
    }

    // make a special setter that we can use in set defaults
    proto['_raw_set_' + name] = function (val, idx) {
        setter.call(this, val, idx);
        //delete this['_init_set_' + name];  // remove it after use
    };
};

Util.make_properties = function (constructor, arr) {
    "use strict";

    for (var i = 0; i < arr.length; i++) {
        Util.make_property(constructor.prototype, arr[i][0], arr[i][1], arr[i][2]);
    }
};

Util.set_defaults = function (obj, conf, defaults) {
    var defaults_keys = Object.keys(defaults);
    var conf_keys = Object.keys(conf);
    var keys_obj = {};
    var i;
    for (i = 0; i < defaults_keys.length; i++) {
        keys_obj[defaults_keys[i]] = 1;
    }
    for (i = 0; i < conf_keys.length; i++) {
        keys_obj[conf_keys[i]] = 1;
    }
    var keys = Object.keys(keys_obj);

    for (i = 0; i < keys.length; i++) {
        var setter = obj['_raw_set_' + keys[i]];
        if (!setter) {
            Util.Warn('Invalid property ' + keys[i]);
            continue;
        }

        if (keys[i] in conf) {
            setter.call(obj, conf[keys[i]]);
        } else {
            setter.call(obj, defaults[keys[i]]);
        }
    }
};

/*
 * Decode from UTF-8
 */
Util.decodeUTF8 = function (utf8string) {
    "use strict";

    return decodeURIComponent(escape(utf8string));
};

/*
 * Cross-browser routines
 */

Util.getPosition = function (obj) {
    "use strict";
    // NB(sross): the Mozilla developer reference seems to indicate that
    // getBoundingClientRect includes border and padding, so the canvas
    // style should NOT include either.

    var objPosition = obj.getBoundingClientRect();
    return { 'x': objPosition.left + window.pageXOffset, 'y': objPosition.top + window.pageYOffset,
        'width': objPosition.width, 'height': objPosition.height };
};

// Get mouse event position in DOM element
Util.getEventPosition = function (e, obj, scale) {
    "use strict";

    var evt, docX, docY, pos;
    //if (!e) evt = window.event;
    evt = e ? e : window.event;
    evt = evt.changedTouches ? evt.changedTouches[0] : evt.touches ? evt.touches[0] : evt;
    if (evt.pageX || evt.pageY) {
        docX = evt.pageX;
        docY = evt.pageY;
    } else if (evt.clientX || evt.clientY) {
        docX = evt.clientX + document.body.scrollLeft + document.documentElement.scrollLeft;
        docY = evt.clientY + document.body.scrollTop + document.documentElement.scrollTop;
    }
    pos = Util.getPosition(obj);
    if (typeof scale === "undefined") {
        scale = 1;
    }
    var realx = docX - pos.x;
    var realy = docY - pos.y;
    var x = Math.max(Math.min(realx, pos.width - 1), 0);
    var y = Math.max(Math.min(realy, pos.height - 1), 0);
    return { 'x': x / scale, 'y': y / scale, 'realx': realx / scale, 'realy': realy / scale };
};

Util.stopEvent = function (e) {
    e.stopPropagation();
    e.preventDefault();
};

Util._cursor_uris_supported = null;

Util.browserSupportsCursorURIs = function () {
    if (Util._cursor_uris_supported === null) {
        try {
            var target = document.createElement('canvas');
            target.style.cursor = 'url("data:image/x-icon;base64,AAACAAEACAgAAAIAAgA4AQAAFgAAACgAAAAIAAAAEAAAAAEAIAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAD/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////AAAAAAAAAAAAAAAAAAAAAA==") 2 2, default';

            if (target.style.cursor) {
                Util.Info("Data URI scheme cursor supported");
                Util._cursor_uris_supported = true;
            } else {
                Util.Warn("Data URI scheme cursor not supported");
                Util._cursor_uris_supported = false;
            }
        } catch (exc) {
            Util.Error("Data URI scheme cursor test exception: " + exc);
            Util._cursor_uris_supported = false;
        }
    }

    return Util._cursor_uris_supported;
};

// Set browser engine versions. Based on mootools.
Util.Features = { xpath: !!document.evaluate, air: !!window.runtime, query: !!document.querySelector };

(function () {
    "use strict";
    // 'presto': (function () { return (!window.opera) ? false : true; }()),

    var detectPresto = function () {
        return !!window.opera;
    };

    // 'trident': (function () { return (!window.ActiveXObject) ? false : ((window.XMLHttpRequest) ? ((document.querySelectorAll) ? 6 : 5) : 4);
    var detectTrident = function () {
        if (!window.ActiveXObject) {
            return false;
        } else {
            if (window.XMLHttpRequest) {
                return document.querySelectorAll ? 6 : 5;
            } else {
                return 4;
            }
        }
    };

    // 'webkit': (function () { try { return (navigator.taintEnabled) ? false : ((Util.Features.xpath) ? ((Util.Features.query) ? 525 : 420) : 419); } catch (e) { return false; } }()),
    var detectInitialWebkit = function () {
        try {
            if (navigator.taintEnabled) {
                return false;
            } else {
                if (Util.Features.xpath) {
                    return Util.Features.query ? 525 : 420;
                } else {
                    return 419;
                }
            }
        } catch (e) {
            return false;
        }
    };

    var detectActualWebkit = function (initial_ver) {
        var re = /WebKit\/([0-9\.]*) /;
        var str_ver = (navigator.userAgent.match(re) || ['', initial_ver])[1];
        return parseFloat(str_ver, 10);
    };

    // 'gecko': (function () { return (!document.getBoxObjectFor && window.mozInnerScreenX == null) ? false : ((document.getElementsByClassName) ? 19ssName) ? 19 : 18 : 18); }())
    var detectGecko = function () {
        /* jshint -W041 */
        if (!document.getBoxObjectFor && window.mozInnerScreenX == null) {
            return false;
        } else {
            return document.getElementsByClassName ? 19 : 18;
        }
        /* jshint +W041 */
    };

    Util.Engine = {
        // Version detection break in Opera 11.60 (errors on arguments.callee.caller reference)
        //'presto': (function() {
        //         return (!window.opera) ? false : ((arguments.callee.caller) ? 960 : ((document.getElementsByClassName) ? 950 : 925)); }()),
        'presto': detectPresto(),
        'trident': detectTrident(),
        'webkit': detectInitialWebkit(),
        'gecko': detectGecko()
    };

    if (Util.Engine.webkit) {
        // Extract actual webkit version if available
        Util.Engine.webkit = detectActualWebkit(Util.Engine.webkit);
    }
})();

Util.Flash = function () {
    "use strict";

    var v, version;
    try {
        v = navigator.plugins['Shockwave Flash'].description;
    } catch (err1) {
        try {
            v = new ActiveXObject('ShockwaveFlash.ShockwaveFlash').GetVariable('$version');
        } catch (err2) {
            v = '0 r0';
        }
    }
    version = v.match(/\d+/g);
    return { version: parseInt(version[0] || 0 + '.' + version[1], 10) || 0, build: parseInt(version[2], 10) || 0 };
}();

exports.default = Util;
module.exports = exports['default'];
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInV0aWwuanMiXSwibmFtZXMiOlsiVXRpbCIsIl9sb2dfbGV2ZWwiLCJpbml0X2xvZ2dpbmciLCJsZXZlbCIsIkRlYnVnIiwiSW5mbyIsIldhcm4iLCJFcnJvciIsIm1zZyIsIndpbmRvdyIsImNvbnNvbGUiLCJsb2ciLCJpbmZvIiwid2FybiIsImVycm9yIiwiZ2V0X2xvZ2dpbmciLCJtYWtlX3Byb3BlcnR5IiwicHJvdG8iLCJuYW1lIiwibW9kZSIsInR5cGUiLCJnZXR0ZXIiLCJpZHgiLCJtYWtlX3NldHRlciIsInByb2Nlc3NfdmFsIiwidmFsIiwic2V0dGVyIiwicGFyc2VJbnQiLCJwYXJzZUZsb2F0IiwiU3RyaW5nIiwiY2FsbCIsIm1ha2VfcHJvcGVydGllcyIsImNvbnN0cnVjdG9yIiwiYXJyIiwiaSIsImxlbmd0aCIsInByb3RvdHlwZSIsInNldF9kZWZhdWx0cyIsIm9iaiIsImNvbmYiLCJkZWZhdWx0cyIsImRlZmF1bHRzX2tleXMiLCJPYmplY3QiLCJrZXlzIiwiY29uZl9rZXlzIiwia2V5c19vYmoiLCJkZWNvZGVVVEY4IiwidXRmOHN0cmluZyIsImRlY29kZVVSSUNvbXBvbmVudCIsImVzY2FwZSIsImdldFBvc2l0aW9uIiwib2JqUG9zaXRpb24iLCJnZXRCb3VuZGluZ0NsaWVudFJlY3QiLCJsZWZ0IiwicGFnZVhPZmZzZXQiLCJ0b3AiLCJwYWdlWU9mZnNldCIsIndpZHRoIiwiaGVpZ2h0IiwiZ2V0RXZlbnRQb3NpdGlvbiIsImUiLCJzY2FsZSIsImV2dCIsImRvY1giLCJkb2NZIiwicG9zIiwiZXZlbnQiLCJjaGFuZ2VkVG91Y2hlcyIsInRvdWNoZXMiLCJwYWdlWCIsInBhZ2VZIiwiY2xpZW50WCIsImNsaWVudFkiLCJkb2N1bWVudCIsImJvZHkiLCJzY3JvbGxMZWZ0IiwiZG9jdW1lbnRFbGVtZW50Iiwic2Nyb2xsVG9wIiwicmVhbHgiLCJ4IiwicmVhbHkiLCJ5IiwiTWF0aCIsIm1heCIsIm1pbiIsInN0b3BFdmVudCIsInN0b3BQcm9wYWdhdGlvbiIsInByZXZlbnREZWZhdWx0IiwiX2N1cnNvcl91cmlzX3N1cHBvcnRlZCIsImJyb3dzZXJTdXBwb3J0c0N1cnNvclVSSXMiLCJ0YXJnZXQiLCJjcmVhdGVFbGVtZW50Iiwic3R5bGUiLCJjdXJzb3IiLCJleGMiLCJGZWF0dXJlcyIsInhwYXRoIiwiZXZhbHVhdGUiLCJhaXIiLCJydW50aW1lIiwicXVlcnkiLCJxdWVyeVNlbGVjdG9yIiwiZGV0ZWN0UHJlc3RvIiwib3BlcmEiLCJkZXRlY3RUcmlkZW50IiwiQWN0aXZlWE9iamVjdCIsIlhNTEh0dHBSZXF1ZXN0IiwicXVlcnlTZWxlY3RvckFsbCIsImRldGVjdEluaXRpYWxXZWJraXQiLCJuYXZpZ2F0b3IiLCJ0YWludEVuYWJsZWQiLCJkZXRlY3RBY3R1YWxXZWJraXQiLCJpbml0aWFsX3ZlciIsInJlIiwic3RyX3ZlciIsInVzZXJBZ2VudCIsIm1hdGNoIiwiZGV0ZWN0R2Vja28iLCJnZXRCb3hPYmplY3RGb3IiLCJtb3pJbm5lclNjcmVlblgiLCJnZXRFbGVtZW50c0J5Q2xhc3NOYW1lIiwiRW5naW5lIiwid2Via2l0IiwiRmxhc2giLCJ2IiwidmVyc2lvbiIsInBsdWdpbnMiLCJkZXNjcmlwdGlvbiIsImVycjEiLCJHZXRWYXJpYWJsZSIsImVycjIiLCJidWlsZCJdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQTs7Ozs7Ozs7QUFRQTtBQUNBOztBQUVBLElBQUlBLE9BQU8sRUFBWDs7QUFFQTs7Ozs7O0FBTUE7Ozs7QUFJQUEsS0FBS0MsVUFBTCxHQUFrQixNQUFsQjtBQUNBRCxLQUFLRSxZQUFMLEdBQW9CLFVBQVVDLEtBQVYsRUFBaUI7QUFDakM7O0FBQ0EsUUFBSSxPQUFPQSxLQUFQLEtBQWlCLFdBQXJCLEVBQWtDO0FBQzlCQSxnQkFBUUgsS0FBS0MsVUFBYjtBQUNILEtBRkQsTUFFTztBQUNIRCxhQUFLQyxVQUFMLEdBQWtCRSxLQUFsQjtBQUNIOztBQUVESCxTQUFLSSxLQUFMLEdBQWFKLEtBQUtLLElBQUwsR0FBWUwsS0FB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RCxDQUFKO0FBQ0gsU0FGRCxDQUVFLE9BQU9DLElBQVAsRUFBYTtBQUNYTixnQkFBSSxNQUFKO0FBQ0g7QUFDSjtBQUNEQyxjQUFVRCxFQUFFUixLQUFGLENBQVEsTUFBUixDQUFWO0FBQ0EsV0FBTyxFQUFDUyxTQUFTbEcsU0FBU2tHLFFBQVEsQ0FBUixLQUFjLElBQUksR0FBSixHQUFVQSxRQUFRLENBQVIsQ0FBakMsRUFBNkMsRUFBN0MsS0FBb0QsQ0FBOUQsRUFBaUVNLE9BQU94RyxTQUFTa0csUUFBUSxDQUFSLENBQVQsRUFBcUIsRUFBckIsS0FBNEIsQ0FBcEcsRUFBUDtBQUNILENBZGEsRUFBZDs7a0JBZ0JlN0gsSSIsImZpbGUiOiJ1dGlsLmpzIiwic291cmNlc0NvbnRlbnQiOlsiLypcbiAqIG5vVk5DOiBIVE1MNSBWTkMgY2xpZW50XG4gKiBDb3B5cmlnaHQgKEMpIDIwMTIgSm9lbCBNYXJ0aW5cbiAqIExpY2Vuc2VkIHVuZGVyIE1QTCAyLjAgKHNlZSBMSUNFTlNFLnR4dClcbiAqXG4gKiBTZWUgUkVBRE1FLm1kIGZvciB1c2FnZSBhbmQgaW50ZWdyYXRpb24gaW5zdHJ1Y3Rpb25zLlxuICovXG5cbi8qIGpzaGludCB3aGl0ZTogZmFsc2UsIG5vbnN0YW5kYXJkOiB0cnVlICovXG4vKmdsb2JhbCB3aW5kb3csIGNvbnNvbGUsIGRvY3VtZW50LCBuYXZpZ2F0b3IsIEFjdGl2ZVhPYmplY3QsIElOQ0xVREVfVVJJICovXG5cbnZhciBVdGlsID0ge307XG5cbi8qXG4gKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAqIE5hbWVzcGFjZWQgaW4gVXRpbFxuICogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gKi9cblxuLypcbiAqIExvZ2dpbmcvZGVidWcgcm91dGluZXNcbiAqL1xuXG5VdGlsLl9sb2dfbGV2ZWwgPSAnd2Fybic7XG5VdGlsLmluaXRfbG9nZ2luZyA9IGZ1bmN0aW9uIChsZXZlbCkge1xuICAgIFwidXNlIHN0cmljdFwiO1xuICAgIGlmICh0eXBlb2YgbGV2ZWwgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgIGxldmVsID0gVXRpbC5fbG9nX2xldmVsO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIFV0aWwuX2xvZ19sZXZlbCA9IGxldmVsO1xuICAgIH1cblxuICAgIFV0aWwuRGVidWcgPSBVdGlsLkluZm8gPSBVdGlsLldhcm4gPSBVdGlsLkVycm9yID0gZnVuY3Rpb24gKG1zZykge307XG4gICAgaWYgKHR5cGVvZiB3aW5kb3cuY29uc29sZSAhPT0gXCJ1bmRlZmluZWRcIikge1xuICAgICAgICAvKiBqc2hpbnQgLVcwODYgKi9cbiAgICAgICAgc3dpdGNoIChsZXZlbCkge1xuICAgICAgICAgICAgY2FzZSAnZGVidWcnOlxuICAgICAgICAgICAgICAgIFV0aWwuRGVidWcgPSBmdW5jdGlvbiAobXNnKSB7IGNvbnNvbGUubG9nKG1zZyk7IH07XG4gICAgICAgICAgICBjYXNlICdpbmZvJzpcbiAgICAgICAgICAgICAgICBVdGlsLkluZm8gID0gZnVuY3Rpb24gKG1zZykgeyBjb25zb2xlLmluZm8obXNnKTsgfTtcbiAgICAgICAgICAgIGNhc2UgJ3dhcm4nOlxuICAgICAgICAgICAgICAgIFV0aWwuV2FybiAgPSBmdW5jdGlvbiAobXNnKSB7IGNvbnNvbGUud2Fybihtc2cpOyB9O1xuICAgICAgICAgICAgY2FzZSAnZXJyb3InOlxuICAgICAgICAgICAgICAgIFV0aWwuRXJyb3IgPSBmdW5jdGlvbiAobXNnKSB7IGNvbnNvbGUuZXJyb3IobXNnKTsgfTtcbiAgICAgICAgICAgIGNhc2UgJ25vbmUnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJpbnZhbGlkIGxvZ2dpbmcgdHlwZSAnXCIgKyBsZXZlbCArIFwiJ1wiKTtcbiAgICAgICAgfVxuICAgICAgICAvKiBqc2hpbnQgK1cwODYgKi9cbiAgICB9XG59O1xuVXRpbC5nZXRfbG9nZ2luZyA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gVXRpbC5fbG9nX2xldmVsO1xufTtcbi8vIEluaXRpYWxpemUgbG9nZ2luZyBsZXZlbFxuVXRpbC5pbml0X2xvZ2dpbmcoKTtcblxuVXRpbC5tYWtlX3Byb3BlcnR5ID0gZnVuY3Rpb24gKHByb3RvLCBuYW1lLCBtb2RlLCB0eXBlKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG5cbiAgICB2YXIgZ2V0dGVyO1xuICAgIGlmICh0eXBlID09PSAnYXJyJykge1xuICAgICAgICBnZXR0ZXIgPSBmdW5jdGlvbiAoaWR4KSB7XG4gICAgICAgICAgICBpZiAodHlwZW9mIGlkeCAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpc1snXycgKyBuYW1lXVtpZHhdO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpc1snXycgKyBuYW1lXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBnZXR0ZXIgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpc1snXycgKyBuYW1lXTtcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICB2YXIgbWFrZV9zZXR0ZXIgPSBmdW5jdGlvbiAocHJvY2Vzc192YWwpIHtcbiAgICAgICAgaWYgKHByb2Nlc3NfdmFsKSB7XG4gICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKHZhbCwgaWR4KSB7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBpZHggIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXNbJ18nICsgbmFtZV1baWR4XSA9IHByb2Nlc3NfdmFsKHZhbCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpc1snXycgKyBuYW1lXSA9IHByb2Nlc3NfdmFsKHZhbCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbiAodmFsLCBpZHgpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGlkeCAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpc1snXycgKyBuYW1lXVtpZHhdID0gdmFsO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXNbJ18nICsgbmFtZV0gPSB2YWw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICB2YXIgc2V0dGVyO1xuICAgIGlmICh0eXBlID09PSAnYm9vbCcpIHtcbiAgICAgICAgc2V0dGVyID0gbWFrZV9zZXR0ZXIoZnVuY3Rpb24gKHZhbCkge1xuICAgICAgICAgICAgaWYgKCF2YWwgfHwgKHZhbCBpbiB7JzAnOiAxLCAnbm8nOiAxLCAnZmFsc2UnOiAxfSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdpbnQnKSB7XG4gICAgICAgIHNldHRlciA9IG1ha2Vfc2V0dGVyKGZ1bmN0aW9uICh2YWwpIHsgcmV0dXJuIHBhcnNlSW50KHZhbCwgMTApOyB9KTtcbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdmbG9hdCcpIHtcbiAgICAgICAgc2V0dGVyID0gbWFrZV9zZXR0ZXIocGFyc2VGbG9hdCk7XG4gICAgfSBlbHNlIGlmICh0eXBlID09PSAnc3RyJykge1xuICAgICAgICBzZXR0ZXIgPSBtYWtlX3NldHRlcihTdHJpbmcpO1xuICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ2Z1bmMnKSB7XG4gICAgICAgIHNldHRlciA9IG1ha2Vfc2V0dGVyKGZ1bmN0aW9uICh2YWwpIHtcbiAgICAgICAgICAgIGlmICghdmFsKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uICgpIHt9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdmFsO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9IGVsc2UgaWYgKHR5cGUgPT09ICdhcnInIHx8IHR5cGUgPT09ICdkb20nIHx8IHR5cGUgPT0gJ3JhdycpIHtcbiAgICAgICAgc2V0dGVyID0gbWFrZV9zZXR0ZXIoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gcHJvcGVydHkgdHlwZSAnICsgdHlwZSk7ICAvLyBzb21lIHNhbml0eSBjaGVja2luZ1xuICAgIH1cblxuICAgIC8vIHNldCB0aGUgZ2V0dGVyXG4gICAgaWYgKHR5cGVvZiBwcm90b1snZ2V0XycgKyBuYW1lXSA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgcHJvdG9bJ2dldF8nICsgbmFtZV0gPSBnZXR0ZXI7XG4gICAgfVxuXG4gICAgLy8gc2V0IHRoZSBzZXR0ZXIgaWYgbmVlZGVkXG4gICAgaWYgKHR5cGVvZiBwcm90b1snc2V0XycgKyBuYW1lXSA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgaWYgKG1vZGUgPT09ICdydycpIHtcbiAgICAgICAgICAgIHByb3RvWydzZXRfJyArIG5hbWVdID0gc2V0dGVyO1xuICAgICAgICB9IGVsc2UgaWYgKG1vZGUgPT09ICd3bycpIHtcbiAgICAgICAgICAgIHByb3RvWydzZXRfJyArIG5hbWVdID0gZnVuY3Rpb24gKHZhbCwgaWR4KSB7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB0aGlzWydfJyArIG5hbWVdICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IobmFtZSArIFwiIGNhbiBvbmx5IGJlIHNldCBvbmNlXCIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzZXR0ZXIuY2FsbCh0aGlzLCB2YWwsIGlkeCk7XG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gbWFrZSBhIHNwZWNpYWwgc2V0dGVyIHRoYXQgd2UgY2FuIHVzZSBpbiBzZXQgZGVmYXVsdHNcbiAgICBwcm90b1snX3Jhd19zZXRfJyArIG5hbWVdID0gZnVuY3Rpb24gKHZhbCwgaWR4KSB7XG4gICAgICAgIHNldHRlci5jYWxsKHRoaXMsIHZhbCwgaWR4KTtcbiAgICAgICAgLy9kZWxldGUgdGhpc1snX2luaXRfc2V0XycgKyBuYW1lXTsgIC8vIHJlbW92ZSBpdCBhZnRlciB1c2VcbiAgICB9O1xufTtcblxuVXRpbC5tYWtlX3Byb3BlcnRpZXMgPSBmdW5jdGlvbiAoY29uc3RydWN0b3IsIGFycikge1xuICAgIFwidXNlIHN0cmljdFwiO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYXJyLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIFV0aWwubWFrZV9wcm9wZXJ0eShjb25zdHJ1Y3Rvci5wcm90b3R5cGUsIGFycltpXVswXSwgYXJyW2ldWzFdLCBhcnJbaV1bMl0pO1xuICAgIH1cbn07XG5cblV0aWwuc2V0X2RlZmF1bHRzID0gZnVuY3Rpb24gKG9iaiwgY29uZiwgZGVmYXVsdHMpIHtcbiAgICB2YXIgZGVmYXVsdHNfa2V5cyA9IE9iamVjdC5rZXlzKGRlZmF1bHRzKTtcbiAgICB2YXIgY29uZl9rZXlzID0gT2JqZWN0LmtleXMoY29uZik7XG4gICAgdmFyIGtleXNfb2JqID0ge307XG4gICAgdmFyIGk7XG4gICAgZm9yIChpID0gMDsgaSA8IGRlZmF1bHRzX2tleXMubGVuZ3RoOyBpKyspIHsga2V5c19vYmpbZGVmYXVsdHNfa2V5c1tpXV0gPSAxOyB9XG4gICAgZm9yIChpID0gMDsgaSA8IGNvbmZfa2V5cy5sZW5ndGg7IGkrKykgeyBrZXlzX29ialtjb25mX2tleXNbaV1dID0gMTsgfVxuICAgIHZhciBrZXlzID0gT2JqZWN0LmtleXMoa2V5c19vYmopO1xuXG4gICAgZm9yIChpID0gMDsgaSA8IGtleXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgdmFyIHNldHRlciA9IG9ialsnX3Jhd19zZXRfJyArIGtleXNbaV1dO1xuICAgICAgICBpZiAoIXNldHRlcikge1xuICAgICAgICAgIFV0aWwuV2FybignSW52YWxpZCBwcm9wZXJ0eSAnICsga2V5c1tpXSk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoa2V5c1tpXSBpbiBjb25mKSB7XG4gICAgICAgICAgICBzZXR0ZXIuY2FsbChvYmosIGNvbmZba2V5c1tpXV0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc2V0dGVyLmNhbGwob2JqLCBkZWZhdWx0c1trZXlzW2ldXSk7XG4gICAgICAgIH1cbiAgICB9XG59O1xuXG4vKlxuICogRGVjb2RlIGZyb20gVVRGLThcbiAqL1xuVXRpbC5kZWNvZGVVVEY4ID0gZnVuY3Rpb24gKHV0ZjhzdHJpbmcpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcbiAgICByZXR1cm4gZGVjb2RlVVJJQ29tcG9uZW50KGVzY2FwZSh1dGY4c3RyaW5nKSk7XG59O1xuXG5cblxuLypcbiAqIENyb3NzLWJyb3dzZXIgcm91dGluZXNcbiAqL1xuXG5VdGlsLmdldFBvc2l0aW9uID0gZnVuY3Rpb24ob2JqKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG4gICAgLy8gTkIoc3Jvc3MpOiB0aGUgTW96aWxsYSBkZXZlbG9wZXIgcmVmZXJlbmNlIHNlZW1zIHRvIGluZGljYXRlIHRoYXRcbiAgICAvLyBnZXRCb3VuZGluZ0NsaWVudFJlY3QgaW5jbHVkZXMgYm9yZGVyIGFuZCBwYWRkaW5nLCBzbyB0aGUgY2FudmFzXG4gICAgLy8gc3R5bGUgc2hvdWxkIE5PVCBpbmNsdWRlIGVpdGhlci5cbiAgICB2YXIgb2JqUG9zaXRpb24gPSBvYmouZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgcmV0dXJuIHsneCc6IG9ialBvc2l0aW9uLmxlZnQgKyB3aW5kb3cucGFnZVhPZmZzZXQsICd5Jzogb2JqUG9zaXRpb24udG9wICsgd2luZG93LnBhZ2VZT2Zmc2V0LFxuICAgICAgICAgICAgJ3dpZHRoJzogb2JqUG9zaXRpb24ud2lkdGgsICdoZWlnaHQnOiBvYmpQb3NpdGlvbi5oZWlnaHR9O1xufTtcblxuXG4vLyBHZXQgbW91c2UgZXZlbnQgcG9zaXRpb24gaW4gRE9NIGVsZW1lbnRcblV0aWwuZ2V0RXZlbnRQb3NpdGlvbiA9IGZ1bmN0aW9uIChlLCBvYmosIHNjYWxlKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG4gICAgdmFyIGV2dCwgZG9jWCwgZG9jWSwgcG9zO1xuICAgIC8vaWYgKCFlKSBldnQgPSB3aW5kb3cuZXZlbnQ7XG4gICAgZXZ0ID0gKGUgPyBlIDogd2luZG93LmV2ZW50KTtcbiAgICBldnQgPSAoZXZ0LmNoYW5nZWRUb3VjaGVzID8gZXZ0LmNoYW5nZWRUb3VjaGVzWzBdIDogZXZ0LnRvdWNoZXMgPyBldnQudG91Y2hlc1swXSA6IGV2dCk7XG4gICAgaWYgKGV2dC5wYWdlWCB8fCBldnQucGFnZVkpIHtcbiAgICAgICAgZG9jWCA9IGV2dC5wYWdlWDtcbiAgICAgICAgZG9jWSA9IGV2dC5wYWdlWTtcbiAgICB9IGVsc2UgaWYgKGV2dC5jbGllbnRYIHx8IGV2dC5jbGllbnRZKSB7XG4gICAgICAgIGRvY1ggPSBldnQuY2xpZW50WCArIGRvY3VtZW50LmJvZHkuc2Nyb2xsTGVmdCArXG4gICAgICAgICAgICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuc2Nyb2xsTGVmdDtcbiAgICAgICAgZG9jWSA9IGV2dC5jbGllbnRZICsgZG9jdW1lbnQuYm9keS5zY3JvbGxUb3AgK1xuICAgICAgICAgICAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LnNjcm9sbFRvcDtcbiAgICB9XG4gICAgcG9zID0gVXRpbC5nZXRQb3NpdGlvbihvYmopO1xuICAgIGlmICh0eXBlb2Ygc2NhbGUgPT09IFwidW5kZWZpbmVkXCIpIHtcbiAgICAgICAgc2NhbGUgPSAxO1xuICAgIH1cbiAgICB2YXIgcmVhbHggPSBkb2NYIC0gcG9zLng7XG4gICAgdmFyIHJlYWx5ID0gZG9jWSAtIHBvcy55O1xuICAgIHZhciB4ID0gTWF0aC5tYXgoTWF0aC5taW4ocmVhbHgsIHBvcy53aWR0aCAtIDEpLCAwKTtcbiAgICB2YXIgeSA9IE1hdGgubWF4KE1hdGgubWluKHJlYWx5LCBwb3MuaGVpZ2h0IC0gMSksIDApO1xuICAgIHJldHVybiB7J3gnOiB4IC8gc2NhbGUsICd5JzogeSAvIHNjYWxlLCAncmVhbHgnOiByZWFseCAvIHNjYWxlLCAncmVhbHknOiByZWFseSAvIHNjYWxlfTtcbn07XG5cblV0aWwuc3RvcEV2ZW50ID0gZnVuY3Rpb24gKGUpIHtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbn07XG5cblV0aWwuX2N1cnNvcl91cmlzX3N1cHBvcnRlZCA9IG51bGw7XG5cblV0aWwuYnJvd3NlclN1cHBvcnRzQ3Vyc29yVVJJcyA9IGZ1bmN0aW9uICgpIHtcbiAgICBpZiAoVXRpbC5fY3Vyc29yX3VyaXNfc3VwcG9ydGVkID09PSBudWxsKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICB2YXIgdGFyZ2V0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnY2FudmFzJyk7XG4gICAgICAgICAgICB0YXJnZXQuc3R5bGUuY3Vyc29yID0gJ3VybChcImRhdGE6aW1hZ2UveC1pY29uO2Jhc2U2NCxBQUFDQUFFQUNBZ0FBQUlBQWdBNEFRQUFGZ0FBQUNnQUFBQUlBQUFBRUFBQUFBRUFJQUFBQUFBQUVBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBRC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vQUFBQUFBQUFBQUFBQUFBQUFBQUFBQT09XCIpIDIgMiwgZGVmYXVsdCc7XG5cbiAgICAgICAgICAgIGlmICh0YXJnZXQuc3R5bGUuY3Vyc29yKSB7XG4gICAgICAgICAgICAgICAgVXRpbC5JbmZvKFwiRGF0YSBVUkkgc2NoZW1lIGN1cnNvciBzdXBwb3J0ZWRcIik7XG4gICAgICAgICAgICAgICAgVXRpbC5fY3Vyc29yX3VyaXNfc3VwcG9ydGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgVXRpbC5XYXJuKFwiRGF0YSBVUkkgc2NoZW1lIGN1cnNvciBub3Qgc3VwcG9ydGVkXCIpO1xuICAgICAgICAgICAgICAgIFV0aWwuX2N1cnNvcl91cmlzX3N1cHBvcnRlZCA9IGZhbHNlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChleGMpIHtcbiAgICAgICAgICAgIFV0aWwuRXJyb3IoXCJEYXRhIFVSSSBzY2hlbWUgY3Vyc29yIHRlc3QgZXhjZXB0aW9uOiBcIiArIGV4Yyk7XG4gICAgICAgICAgICBVdGlsLl9jdXJzb3JfdXJpc19zdXBwb3J0ZWQgPSBmYWxzZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBVdGlsLl9jdXJzb3JfdXJpc19zdXBwb3J0ZWQ7XG59O1xuXG4vLyBTZXQgYnJvd3NlciBlbmdpbmUgdmVyc2lvbnMuIEJhc2VkIG9uIG1vb3Rvb2xzLlxuVXRpbC5GZWF0dXJlcyA9IHt4cGF0aDogISEoZG9jdW1lbnQuZXZhbHVhdGUpLCBhaXI6ICEhKHdpbmRvdy5ydW50aW1lKSwgcXVlcnk6ICEhKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IpfTtcblxuKGZ1bmN0aW9uICgpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcbiAgICAvLyAncHJlc3RvJzogKGZ1bmN0aW9uICgpIHsgcmV0dXJuICghd2luZG93Lm9wZXJhKSA/IGZhbHNlIDogdHJ1ZTsgfSgpKSxcbiAgICB2YXIgZGV0ZWN0UHJlc3RvID0gZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gISF3aW5kb3cub3BlcmE7XG4gICAgfTtcblxuICAgIC8vICd0cmlkZW50JzogKGZ1bmN0aW9uICgpIHsgcmV0dXJuICghd2luZG93LkFjdGl2ZVhPYmplY3QpID8gZmFsc2UgOiAoKHdpbmRvdy5YTUxIdHRwUmVxdWVzdCkgPyAoKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwpID8gNiA6IDUpIDogNCk7XG4gICAgdmFyIGRldGVjdFRyaWRlbnQgPSBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGlmICghd2luZG93LkFjdGl2ZVhPYmplY3QpIHtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh3aW5kb3cuWE1MSHR0cFJlcXVlc3QpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwpID8gNiA6IDU7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiA0O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfTtcblxuICAgIC8vICd3ZWJraXQnOiAoZnVuY3Rpb24gKCkgeyB0cnkgeyByZXR1cm4gKG5hdmlnYXRvci50YWludEVuYWJsZWQpID8gZmFsc2UgOiAoKFV0aWwuRmVhdHVyZXMueHBhdGgpID8gKChVdGlsLkZlYXR1cmVzLnF1ZXJ5KSA/IDUyNSA6IDQyMCkgOiA0MTkpOyB9IGNhdGNoIChlKSB7IHJldHVybiBmYWxzZTsgfSB9KCkpLFxuICAgIHZhciBkZXRlY3RJbml0aWFsV2Via2l0ID0gZnVuY3Rpb24gKCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgaWYgKG5hdmlnYXRvci50YWludEVuYWJsZWQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChVdGlsLkZlYXR1cmVzLnhwYXRoKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAoVXRpbC5GZWF0dXJlcy5xdWVyeSkgPyA1MjUgOiA0MjA7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIDQxOTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgIH07XG5cbiAgICB2YXIgZGV0ZWN0QWN0dWFsV2Via2l0ID0gZnVuY3Rpb24gKGluaXRpYWxfdmVyKSB7XG4gICAgICAgIHZhciByZSA9IC9XZWJLaXRcXC8oWzAtOVxcLl0qKSAvO1xuICAgICAgICB2YXIgc3RyX3ZlciA9IChuYXZpZ2F0b3IudXNlckFnZW50Lm1hdGNoKHJlKSB8fCBbJycsIGluaXRpYWxfdmVyXSlbMV07XG4gICAgICAgIHJldHVybiBwYXJzZUZsb2F0KHN0cl92ZXIsIDEwKTtcbiAgICB9O1xuXG4gICAgLy8gJ2dlY2tvJzogKGZ1bmN0aW9uICgpIHsgcmV0dXJuICghZG9jdW1lbnQuZ2V0Qm94T2JqZWN0Rm9yICYmIHdpbmRvdy5tb3pJbm5lclNjcmVlblggPT0gbnVsbCkgPyBmYWxzZSA6ICgoZG9jdW1lbnQuZ2V0RWxlbWVudHNCeUNsYXNzTmFtZSkgPyAxOXNzTmFtZSkgPyAxOSA6IDE4IDogMTgpOyB9KCkpXG4gICAgdmFyIGRldGVjdEdlY2tvID0gZnVuY3Rpb24gKCkge1xuICAgICAgICAvKiBqc2hpbnQgLVcwNDEgKi9cbiAgICAgICAgaWYgKCFkb2N1bWVudC5nZXRCb3hPYmplY3RGb3IgJiYgd2luZG93Lm1veklubmVyU2NyZWVuWCA9PSBudWxsKSB7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm4gKGRvY3VtZW50LmdldEVsZW1lbnRzQnlDbGFzc05hbWUpID8gMTkgOiAxODtcbiAgICAgICAgfVxuICAgICAgICAvKiBqc2hpbnQgK1cwNDEgKi9cbiAgICB9O1xuXG4gICAgVXRpbC5FbmdpbmUgPSB7XG4gICAgICAgIC8vIFZlcnNpb24gZGV0ZWN0aW9uIGJyZWFrIGluIE9wZXJhIDExLjYwIChlcnJvcnMgb24gYXJndW1lbnRzLmNhbGxlZS5jYWxsZXIgcmVmZXJlbmNlKVxuICAgICAgICAvLydwcmVzdG8nOiAoZnVuY3Rpb24oKSB7XG4gICAgICAgIC8vICAgICAgICAgcmV0dXJuICghd2luZG93Lm9wZXJhKSA/IGZhbHNlIDogKChhcmd1bWVudHMuY2FsbGVlLmNhbGxlcikgPyA5NjAgOiAoKGRvY3VtZW50LmdldEVsZW1lbnRzQnlDbGFzc05hbWUpID8gOTUwIDogOTI1KSk7IH0oKSksXG4gICAgICAgICdwcmVzdG8nOiBkZXRlY3RQcmVzdG8oKSxcbiAgICAgICAgJ3RyaWRlbnQnOiBkZXRlY3RUcmlkZW50KCksXG4gICAgICAgICd3ZWJraXQnOiBkZXRlY3RJbml0aWFsV2Via2l0KCksXG4gICAgICAgICdnZWNrbyc6IGRldGVjdEdlY2tvKCksXG4gICAgfTtcblxuICAgIGlmIChVdGlsLkVuZ2luZS53ZWJraXQpIHtcbiAgICAgICAgLy8gRXh0cmFjdCBhY3R1YWwgd2Via2l0IHZlcnNpb24gaWYgYXZhaWxhYmxlXG4gICAgICAgIFV0aWwuRW5naW5lLndlYmtpdCA9IGRldGVjdEFjdHVhbFdlYmtpdChVdGlsLkVuZ2luZS53ZWJraXQpO1xuICAgIH1cbn0pKCk7XG5cblV0aWwuRmxhc2ggPSAoZnVuY3Rpb24gKCkge1xuICAgIFwidXNlIHN0cmljdFwiO1xuICAgIHZhciB2LCB2ZXJzaW9uO1xuICAgIHRyeSB7XG4gICAgICAgIHYgPSBuYXZpZ2F0b3IucGx1Z2luc1snU2hvY2t3YXZlIEZsYXNoJ10uZGVzY3JpcHRpb247XG4gICAgfSBjYXRjaCAoZXJyMSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgdiA9IG5ldyBBY3RpdmVYT2JqZWN0KCdTaG9ja3dhdmVGbGFzaC5TaG9ja3dhdmVGbGFzaCcpLkdldFZhcmlhYmxlKCckdmVyc2lvbicpO1xuICAgICAgICB9IGNhdGNoIChlcnIyKSB7XG4gICAgICAgICAgICB2ID0gJzAgcjAnO1xuICAgICAgICB9XG4gICAgfVxuICAgIHZlcnNpb24gPSB2Lm1hdGNoKC9cXGQrL2cpO1xuICAgIHJldHVybiB7dmVyc2lvbjogcGFyc2VJbnQodmVyc2lvblswXSB8fCAwICsgJy4nICsgdmVyc2lvblsxXSwgMTApIHx8IDAsIGJ1aWxkOiBwYXJzZUludCh2ZXJzaW9uWzJdLCAxMCkgfHwgMH07XG59KCkpO1xuXG5leHBvcnQgZGVmYXVsdCBVdGlsO1xuIl19