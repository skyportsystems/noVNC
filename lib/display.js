"use strict";

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.default = Display;

var _util = require("./util");

var _util2 = _interopRequireDefault(_util);

var _base = require("./base64");

var _base2 = _interopRequireDefault(_base);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2012 Joel Martin
 * Copyright (C) 2015 Samuel Mannehed for Cendio AB
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 */

/*jslint browser: true, white: false */
/*global Util, Base64, changeCursor */

function Display(defaults) {
    this._drawCtx = null;
    this._c_forceCanvas = false;

    this._renderQ = []; // queue drawing actions for in-oder rendering

    // the full frame buffer (logical canvas) size
    this._fb_width = 0;
    this._fb_height = 0;

    // the size limit of the viewport (start disabled)
    this._maxWidth = 0;
    this._maxHeight = 0;

    // the visible "physical canvas" viewport
    this._viewportLoc = { 'x': 0, 'y': 0, 'w': 0, 'h': 0 };
    this._cleanRect = { 'x1': 0, 'y1': 0, 'x2': -1, 'y2': -1 };

    this._prevDrawStyle = "";
    this._tile = null;
    this._tile16x16 = null;
    this._tile_x = 0;
    this._tile_y = 0;

    _util2.default.set_defaults(this, defaults, {
        'true_color': true,
        'colourMap': [],
        'scale': 1.0,
        'viewport': false,
        'render_mode': ''
    });

    _util2.default.Debug(">> Display.constructor");

    if (!this._target) {
        throw new Error("Target must be set");
    }

    if (typeof this._target === 'string') {
        throw new Error('target must be a DOM element');
    }

    if (!this._target.getContext) {
        throw new Error("no getContext method");
    }

    if (!this._drawCtx) {
        this._drawCtx = this._target.getContext('2d');
    }

    _util2.default.Debug("User Agent: " + navigator.userAgent);
    if (_util2.default.Engine.gecko) {
        _util2.default.Debug("Browser: gecko " + _util2.default.Engine.gecko);
    }
    if (_util2.default.Engine.webkit) {
        _util2.default.Debug("Browser: webkit " + _util2.default.Engine.webkit);
    }
    if (_util2.default.Engine.trident) {
        _util2.default.Debug("Browser: trident " + _util2.default.Engine.trident);
    }
    if (_util2.default.Engine.presto) {
        _util2.default.Debug("Browser: presto " + _util2.default.Engine.presto);
    }

    this.clear();

    // Check canvas features
    if ('createImageData' in this._drawCtx) {
        this._render_mode = 'canvas rendering';
    } else {
        throw new Error("Canvas does not support createImageData");
    }

    if (this._prefer_js === null) {
        _util2.default.Info("Prefering javascript operations");
        this._prefer_js = true;
    }

    // Determine browser support for setting the cursor via data URI scheme
    if (this._cursor_uri || this._cursor_uri === null || this._cursor_uri === undefined) {
        this._cursor_uri = _util2.default.browserSupportsCursorURIs();
    }

    _util2.default.Debug("<< Display.constructor");
};

(function () {
    "use strict";

    var SUPPORTS_IMAGEDATA_CONSTRUCTOR = false;
    try {
        new ImageData(new Uint8ClampedArray(4), 1, 1);
        SUPPORTS_IMAGEDATA_CONSTRUCTOR = true;
    } catch (ex) {
        // ignore failure
    }

    Display.prototype = {
        // Public methods
        viewportChangePos: function (deltaX, deltaY) {
            var vp = this._viewportLoc;
            deltaX = Math.floor(deltaX);
            deltaY = Math.floor(deltaY);

            if (!this._viewport) {
                deltaX = -vp.w; // clamped later of out of bounds
                deltaY = -vp.h;
            }

            var vx2 = vp.x + vp.w - 1;
            var vy2 = vp.y + vp.h - 1;

            // Position change

            if (deltaX < 0 && vp.x + deltaX < 0) {
                deltaX = -vp.x;
            }
            if (vx2 + deltaX >= this._fb_width) {
                deltaX -= vx2 + deltaX - this._fb_width + 1;
            }

            if (vp.y + deltaY < 0) {
                deltaY = -vp.y;
            }
            if (vy2 + deltaY >= this._fb_height) {
                deltaY -= vy2 + deltaY - this._fb_height + 1;
            }

            if (deltaX === 0 && deltaY === 0) {
                return;
            }
            _util2.default.Debug("viewportChange deltaX: " + deltaX + ", deltaY: " + deltaY);

            vp.x += deltaX;
            vx2 += deltaX;
            vp.y += deltaY;
            vy2 += deltaY;

            // Update the clean rectangle
            var cr = this._cleanRect;
            if (vp.x > cr.x1) {
                cr.x1 = vp.x;
            }
            if (vx2 < cr.x2) {
                cr.x2 = vx2;
            }
            if (vp.y > cr.y1) {
                cr.y1 = vp.y;
            }
            if (vy2 < cr.y2) {
                cr.y2 = vy2;
            }

            var x1, w;
            if (deltaX < 0) {
                // Shift viewport left, redraw left section
                x1 = 0;
                w = -deltaX;
            } else {
                // Shift viewport right, redraw right section
                x1 = vp.w - deltaX;
                w = deltaX;
            }

            var y1, h;
            if (deltaY < 0) {
                // Shift viewport up, redraw top section
                y1 = 0;
                h = -deltaY;
            } else {
                // Shift viewport down, redraw bottom section
                y1 = vp.h - deltaY;
                h = deltaY;
            }

            var saveStyle = this._drawCtx.fillStyle;
            var canvas = this._target;
            this._drawCtx.fillStyle = "rgb(255,255,255)";

            // Due to this bug among others [1] we need to disable the image-smoothing to
            // avoid getting a blur effect when panning.
            //
            // 1. https://bugzilla.mozilla.org/show_bug.cgi?id=1194719
            //
            // We need to set these every time since all properties are reset
            // when the the size is changed
            if (this._drawCtx.mozImageSmoothingEnabled) {
                this._drawCtx.mozImageSmoothingEnabled = false;
            } else if (this._drawCtx.webkitImageSmoothingEnabled) {
                this._drawCtx.webkitImageSmoothingEnabled = false;
            } else if (this._drawCtx.msImageSmoothingEnabled) {
                this._drawCtx.msImageSmoothingEnabled = false;
            } else if (this._drawCtx.imageSmoothingEnabled) {
                this._drawCtx.imageSmoothingEnabled = false;
            }

            // Copy the valid part of the viewport to the shifted location
            this._drawCtx.drawImage(canvas, 0, 0, vp.w, vp.h, -deltaX, -deltaY, vp.w, vp.h);

            if (deltaX !== 0) {
                this._drawCtx.fillRect(x1, 0, w, vp.h);
            }
            if (deltaY !== 0) {
                this._drawCtx.fillRect(0, y1, vp.w, h);
            }
            this._drawCtx.fillStyle = saveStyle;
        },

        viewportChangeSize: function (width, height) {

            if (typeof width === "undefined" || typeof height === "undefined") {

                _util2.default.Debug("Setting viewport to full display region");
                width = this._fb_width;
                height = this._fb_height;
            }

            var vp = this._viewportLoc;
            if (vp.w !== width || vp.h !== height) {

                if (this._viewport) {
                    if (this._maxWidth !== 0 && width > this._maxWidth) {
                        width = this._maxWidth;
                    }
                    if (this._maxHeight !== 0 && height > this._maxHeight) {
                        height = this._maxHeight;
                    }
                }

                var cr = this._cleanRect;

                if (width < vp.w && cr.x2 > vp.x + width - 1) {
                    cr.x2 = vp.x + width - 1;
                }
                if (height < vp.h && cr.y2 > vp.y + height - 1) {
                    cr.y2 = vp.y + height - 1;
                }

                vp.w = width;
                vp.h = height;

                var canvas = this._target;
                if (canvas.width !== width || canvas.height !== height) {

                    // We have to save the canvas data since changing the size will clear it
                    var saveImg = null;
                    if (vp.w > 0 && vp.h > 0 && canvas.width > 0 && canvas.height > 0) {
                        var img_width = canvas.width < vp.w ? canvas.width : vp.w;
                        var img_height = canvas.height < vp.h ? canvas.height : vp.h;
                        saveImg = this._drawCtx.getImageData(0, 0, img_width, img_height);
                    }

                    if (canvas.width !== width) {
                        canvas.width = width;
                        canvas.style.width = width + 'px';
                    }
                    if (canvas.height !== height) {
                        canvas.height = height;
                        canvas.style.height = height + 'px';
                    }

                    if (saveImg) {
                        this._drawCtx.putImageData(saveImg, 0, 0);
                    }
                }
            }
        },

        // Return a map of clean and dirty areas of the viewport and reset the
        // tracking of clean and dirty areas
        //
        // Returns: { 'cleanBox': { 'x': x, 'y': y, 'w': w, 'h': h},
        //            'dirtyBoxes': [{ 'x': x, 'y': y, 'w': w, 'h': h }, ...] }
        getCleanDirtyReset: function () {
            var vp = this._viewportLoc;
            var cr = this._cleanRect;

            var cleanBox = { 'x': cr.x1, 'y': cr.y1,
                'w': cr.x2 - cr.x1 + 1, 'h': cr.y2 - cr.y1 + 1 };

            var dirtyBoxes = [];
            if (cr.x1 >= cr.x2 || cr.y1 >= cr.y2) {
                // Whole viewport is dirty
                dirtyBoxes.push({ 'x': vp.x, 'y': vp.y, 'w': vp.w, 'h': vp.h });
            } else {
                // Redraw dirty regions
                var vx2 = vp.x + vp.w - 1;
                var vy2 = vp.y + vp.h - 1;

                if (vp.x < cr.x1) {
                    // left side dirty region
                    dirtyBoxes.push({ 'x': vp.x, 'y': vp.y,
                        'w': cr.x1 - vp.x + 1, 'h': vp.h });
                }
                if (vx2 > cr.x2) {
                    // right side dirty region
                    dirtyBoxes.push({ 'x': cr.x2 + 1, 'y': vp.y,
                        'w': vx2 - cr.x2, 'h': vp.h });
                }
                if (vp.y < cr.y1) {
                    // top/middle dirty region
                    dirtyBoxes.push({ 'x': cr.x1, 'y': vp.y,
                        'w': cr.x2 - cr.x1 + 1, 'h': cr.y1 - vp.y });
                }
                if (vy2 > cr.y2) {
                    // bottom/middle dirty region
                    dirtyBoxes.push({ 'x': cr.x1, 'y': cr.y2 + 1,
                        'w': cr.x2 - cr.x1 + 1, 'h': vy2 - cr.y2 });
                }
            }

            this._cleanRect = { 'x1': vp.x, 'y1': vp.y,
                'x2': vp.x + vp.w - 1, 'y2': vp.y + vp.h - 1 };

            return { 'cleanBox': cleanBox, 'dirtyBoxes': dirtyBoxes };
        },

        absX: function (x) {
            return x + this._viewportLoc.x;
        },

        absY: function (y) {
            return y + this._viewportLoc.y;
        },

        resize: function (width, height) {
            this._prevDrawStyle = "";

            this._fb_width = width;
            this._fb_height = height;

            this._rescale(this._scale);

            this.viewportChangeSize();
        },

        clear: function () {
            if (this._logo) {
                this.resize(this._logo.width, this._logo.height);
                this.blitStringImage(this._logo.data, 0, 0);
            } else {
                if (_util2.default.Engine.trident === 6) {
                    // NB(directxman12): there's a bug in IE10 where we can fail to actually
                    //                   clear the canvas here because of the resize.
                    //                   Clearing the current viewport first fixes the issue
                    this._drawCtx.clearRect(0, 0, this._viewportLoc.w, this._viewportLoc.h);
                }
                this.resize(240, 20);
                this._drawCtx.clearRect(0, 0, this._viewportLoc.w, this._viewportLoc.h);
            }

            this._renderQ = [];
        },

        fillRect: function (x, y, width, height, color, from_queue) {
            if (this._renderQ.length !== 0 && !from_queue) {
                this.renderQ_push({
                    'type': 'fill',
                    'x': x,
                    'y': y,
                    'width': width,
                    'height': height,
                    'color': color
                });
            } else {
                this._setFillColor(color);
                this._drawCtx.fillRect(x - this._viewportLoc.x, y - this._viewportLoc.y, width, height);
            }
        },

        copyImage: function (old_x, old_y, new_x, new_y, w, h, from_queue) {
            if (this._renderQ.length !== 0 && !from_queue) {
                this.renderQ_push({
                    'type': 'copy',
                    'old_x': old_x,
                    'old_y': old_y,
                    'x': new_x,
                    'y': new_y,
                    'width': w,
                    'height': h
                });
            } else {
                var x1 = old_x - this._viewportLoc.x;
                var y1 = old_y - this._viewportLoc.y;
                var x2 = new_x - this._viewportLoc.x;
                var y2 = new_y - this._viewportLoc.y;

                this._drawCtx.drawImage(this._target, x1, y1, w, h, x2, y2, w, h);
            }
        },

        // start updating a tile
        startTile: function (x, y, width, height, color) {
            this._tile_x = x;
            this._tile_y = y;
            if (width === 16 && height === 16) {
                this._tile = this._tile16x16;
            } else {
                this._tile = this._drawCtx.createImageData(width, height);
            }

            if (this._prefer_js) {
                var bgr;
                if (this._true_color) {
                    bgr = color;
                } else {
                    bgr = this._colourMap[color[0]];
                }
                var red = bgr[2];
                var green = bgr[1];
                var blue = bgr[0];

                var data = this._tile.data;
                for (var i = 0; i < width * height * 4; i += 4) {
                    data[i] = red;
                    data[i + 1] = green;
                    data[i + 2] = blue;
                    data[i + 3] = 255;
                }
            } else {
                this.fillRect(x, y, width, height, color, true);
            }
        },

        // update sub-rectangle of the current tile
        subTile: function (x, y, w, h, color) {
            if (this._prefer_js) {
                var bgr;
                if (this._true_color) {
                    bgr = color;
                } else {
                    bgr = this._colourMap[color[0]];
                }
                var red = bgr[2];
                var green = bgr[1];
                var blue = bgr[0];
                var xend = x + w;
                var yend = y + h;

                var data = this._tile.data;
                var width = this._tile.width;
                for (var j = y; j < yend; j++) {
                    for (var i = x; i < xend; i++) {
                        var p = (i + j * width) * 4;
                        data[p] = red;
                        data[p + 1] = green;
                        data[p + 2] = blue;
                        data[p + 3] = 255;
                    }
                }
            } else {
                this.fillRect(this._tile_x + x, this._tile_y + y, w, h, color, true);
            }
        },

        // draw the current tile to the screen
        finishTile: function () {
            if (this._prefer_js) {
                this._drawCtx.putImageData(this._tile, this._tile_x - this._viewportLoc.x, this._tile_y - this._viewportLoc.y);
            }
            // else: No-op -- already done by setSubTile
        },

        blitImage: function (x, y, width, height, arr, offset, from_queue) {
            if (this._renderQ.length !== 0 && !from_queue) {
                // NB(directxman12): it's technically more performant here to use preallocated arrays,
                // but it's a lot of extra work for not a lot of payoff -- if we're using the render queue,
                // this probably isn't getting called *nearly* as much
                var new_arr = new Uint8Array(width * height * 4);
                new_arr.set(new Uint8Array(arr.buffer, 0, new_arr.length));
                this.renderQ_push({
                    'type': 'blit',
                    'data': new_arr,
                    'x': x,
                    'y': y,
                    'width': width,
                    'height': height
                });
            } else if (this._true_color) {
                this._bgrxImageData(x, y, this._viewportLoc.x, this._viewportLoc.y, width, height, arr, offset);
            } else {
                this._cmapImageData(x, y, this._viewportLoc.x, this._viewportLoc.y, width, height, arr, offset);
            }
        },

        blitRgbImage: function (x, y, width, height, arr, offset, from_queue) {
            if (this._renderQ.length !== 0 && !from_queue) {
                // NB(directxman12): it's technically more performant here to use preallocated arrays,
                // but it's a lot of extra work for not a lot of payoff -- if we're using the render queue,
                // this probably isn't getting called *nearly* as much
                var new_arr = new Uint8Array(width * height * 3);
                new_arr.set(new Uint8Array(arr.buffer, 0, new_arr.length));
                this.renderQ_push({
                    'type': 'blitRgb',
                    'data': new_arr,
                    'x': x,
                    'y': y,
                    'width': width,
                    'height': height
                });
            } else if (this._true_color) {
                this._rgbImageData(x, y, this._viewportLoc.x, this._viewportLoc.y, width, height, arr, offset);
            } else {
                // probably wrong?
                this._cmapImageData(x, y, this._viewportLoc.x, this._viewportLoc.y, width, height, arr, offset);
            }
        },

        blitRgbxImage: function (x, y, width, height, arr, offset, from_queue) {
            if (this._renderQ.length !== 0 && !from_queue) {
                // NB(directxman12): it's technically more performant here to use preallocated arrays,
                // but it's a lot of extra work for not a lot of payoff -- if we're using the render queue,
                // this probably isn't getting called *nearly* as much
                var new_arr = new Uint8Array(width * height * 4);
                new_arr.set(new Uint8Array(arr.buffer, 0, new_arr.length));
                this.renderQ_push({
                    'type': 'blitRgbx',
                    'data': new_arr,
                    'x': x,
                    'y': y,
                    'width': width,
                    'height': height
                });
            } else {
                this._rgbxImageData(x, y, this._viewportLoc.x, this._viewportLoc.y, width, height, arr, offset);
            }
        },

        blitStringImage: function (str, x, y) {
            var img = new Image();
            img.onload = function () {
                this._drawCtx.drawImage(img, x - this._viewportLoc.x, y - this._viewportLoc.y);
            }.bind(this);
            img.src = str;
            return img; // for debugging purposes
        },

        // wrap ctx.drawImage but relative to viewport
        drawImage: function (img, x, y) {
            this._drawCtx.drawImage(img, x - this._viewportLoc.x, y - this._viewportLoc.y);
        },

        renderQ_push: function (action) {
            this._renderQ.push(action);
            if (this._renderQ.length === 1) {
                // If this can be rendered immediately it will be, otherwise
                // the scanner will start polling the queue (every
                // requestAnimationFrame interval)
                this._scan_renderQ();
            }
        },

        changeCursor: function (pixels, mask, hotx, hoty, w, h) {
            if (this._cursor_uri === false) {
                _util2.default.Warn("changeCursor called but no cursor data URI support");
                return;
            }

            if (this._true_color) {
                Display.changeCursor(this._target, pixels, mask, hotx, hoty, w, h);
            } else {
                Display.changeCursor(this._target, pixels, mask, hotx, hoty, w, h, this._colourMap);
            }
        },

        defaultCursor: function () {
            this._target.style.cursor = "default";
        },

        disableLocalCursor: function () {
            this._target.style.cursor = "none";
        },

        clippingDisplay: function () {
            var vp = this._viewportLoc;

            var fbClip = this._fb_width > vp.w || this._fb_height > vp.h;
            var limitedVp = this._maxWidth !== 0 && this._maxHeight !== 0;
            var clipping = false;

            if (limitedVp) {
                clipping = vp.w > this._maxWidth || vp.h > this._maxHeight;
            }

            return fbClip || limitedVp && clipping;
        },

        // Overridden getters/setters
        get_context: function () {
            return this._drawCtx;
        },

        set_scale: function (scale) {
            this._rescale(scale);
        },

        set_width: function (w) {
            this._fb_width = w;
        },
        get_width: function () {
            return this._fb_width;
        },

        set_height: function (h) {
            this._fb_height = h;
        },
        get_height: function () {
            return this._fb_height;
        },

        autoscale: function (containerWidth, containerHeight, downscaleOnly) {
            var targetAspectRatio = containerWidth / containerHeight;
            var fbAspectRatio = this._fb_width / this._fb_height;

            var scaleRatio;
            if (fbAspectRatio >= targetAspectRatio) {
                scaleRatio = containerWidth / this._fb_width;
            } else {
                scaleRatio = containerHeight / this._fb_height;
            }

            var targetW, targetH;
            if (scaleRatio > 1.0 && downscaleOnly) {
                targetW = this._fb_width;
                targetH = this._fb_height;
                scaleRatio = 1.0;
            } else if (fbAspectRatio >= targetAspectRatio) {
                targetW = containerWidth;
                targetH = Math.round(containerWidth / fbAspectRatio);
            } else {
                targetW = Math.round(containerHeight * fbAspectRatio);
                targetH = containerHeight;
            }

            // NB(directxman12): If you set the width directly, or set the
            //                   style width to a number, the canvas is cleared.
            //                   However, if you set the style width to a string
            //                   ('NNNpx'), the canvas is scaled without clearing.
            this._target.style.width = targetW + 'px';
            this._target.style.height = targetH + 'px';

            this._scale = scaleRatio;

            return scaleRatio; // so that the mouse, etc scale can be set
        },

        // Private Methods
        _rescale: function (factor) {
            this._scale = factor;

            var w;
            var h;

            if (this._viewport && this._maxWidth !== 0 && this._maxHeight !== 0) {
                w = Math.min(this._fb_width, this._maxWidth);
                h = Math.min(this._fb_height, this._maxHeight);
            } else {
                w = this._fb_width;
                h = this._fb_height;
            }

            this._target.style.width = Math.round(factor * w) + 'px';
            this._target.style.height = Math.round(factor * h) + 'px';
        },

        _setFillColor: function (color) {
            var bgr;
            if (this._true_color) {
                bgr = color;
            } else {
                bgr = this._colourMap[color];
            }

            var newStyle = 'rgb(' + bgr[2] + ',' + bgr[1] + ',' + bgr[0] + ')';
            if (newStyle !== this._prevDrawStyle) {
                this._drawCtx.fillStyle = newStyle;
                this._prevDrawStyle = newStyle;
            }
        },

        _rgbImageData: function (x, y, vx, vy, width, height, arr, offset) {
            var img = this._drawCtx.createImageData(width, height);
            var data = img.data;
            for (var i = 0, j = offset; i < width * height * 4; i += 4, j += 3) {
                data[i] = arr[j];
                data[i + 1] = arr[j + 1];
                data[i + 2] = arr[j + 2];
                data[i + 3] = 255; // Alpha
            }
            this._drawCtx.putImageData(img, x - vx, y - vy);
        },

        _bgrxImageData: function (x, y, vx, vy, width, height, arr, offset) {
            var img = this._drawCtx.createImageData(width, height);
            var data = img.data;
            for (var i = 0, j = offset; i < width * height * 4; i += 4, j += 4) {
                data[i] = arr[j + 2];
                data[i + 1] = arr[j + 1];
                data[i + 2] = arr[j];
                data[i + 3] = 255; // Alpha
            }
            this._drawCtx.putImageData(img, x - vx, y - vy);
        },

        _rgbxImageData: function (x, y, vx, vy, width, height, arr, offset) {
            // NB(directxman12): arr must be an Type Array view
            var img;
            if (SUPPORTS_IMAGEDATA_CONSTRUCTOR) {
                img = new ImageData(new Uint8ClampedArray(arr.buffer, arr.byteOffset, width * height * 4), width, height);
            } else {
                img = this._drawCtx.createImageData(width, height);
                img.data.set(new Uint8ClampedArray(arr.buffer, arr.byteOffset, width * height * 4));
            }
            this._drawCtx.putImageData(img, x - vx, y - vy);
        },

        _cmapImageData: function (x, y, vx, vy, width, height, arr, offset) {
            var img = this._drawCtx.createImageData(width, height);
            var data = img.data;
            var cmap = this._colourMap;
            for (var i = 0, j = offset; i < width * height * 4; i += 4, j++) {
                var bgr = cmap[arr[j]];
                data[i] = bgr[2];
                data[i + 1] = bgr[1];
                data[i + 2] = bgr[0];
                data[i + 3] = 255; // Alpha
            }
            this._drawCtx.putImageData(img, x - vx, y - vy);
        },

        _scan_renderQ: function () {
            var ready = true;
            while (ready && this._renderQ.length > 0) {
                var a = this._renderQ[0];
                switch (a.type) {
                    case 'copy':
                        this.copyImage(a.old_x, a.old_y, a.x, a.y, a.width, a.height, true);
                        break;
                    case 'fill':
                        this.fillRect(a.x, a.y, a.width, a.height, a.color, true);
                        break;
                    case 'blit':
                        this.blitImage(a.x, a.y, a.width, a.height, a.data, 0, true);
                        break;
                    case 'blitRgb':
                        this.blitRgbImage(a.x, a.y, a.width, a.height, a.data, 0, true);
                        break;
                    case 'blitRgbx':
                        this.blitRgbxImage(a.x, a.y, a.width, a.height, a.data, 0, true);
                        break;
                    case 'img':
                        if (a.img.complete) {
                            this.drawImage(a.img, a.x, a.y);
                        } else {
                            // We need to wait for this image to 'load'
                            // to keep things in-order
                            ready = false;
                        }
                        break;
                }

                if (ready) {
                    this._renderQ.shift();
                }
            }

            if (this._renderQ.length > 0) {
                requestAnimationFrame(this._scan_renderQ.bind(this));
            }
        }
    };

    _util2.default.make_properties(Display, [['target', 'wo', 'dom'], // Canvas element for rendering
    ['context', 'ro', 'raw'], // Canvas 2D context for rendering (read-only)
    ['logo', 'rw', 'raw'], // Logo to display when cleared: {"width": w, "height": h, "data": data}
    ['true_color', 'rw', 'bool'], // Use true-color pixel data
    ['colourMap', 'rw', 'arr'], // Colour map array (when not true-color)
    ['scale', 'rw', 'float'], // Display area scale factor 0.0 - 1.0
    ['viewport', 'rw', 'bool'], // Use viewport clipping
    ['width', 'rw', 'int'], // Display area width
    ['height', 'rw', 'int'], // Display area height
    ['maxWidth', 'rw', 'int'], // Viewport max width (0 if disabled)
    ['maxHeight', 'rw', 'int'], // Viewport max height (0 if disabled)

    ['render_mode', 'ro', 'str'], // Canvas rendering mode (read-only)

    ['prefer_js', 'rw', 'str'], // Prefer Javascript over canvas methods
    ['cursor_uri', 'rw', 'raw'] // Can we render cursor using data URI
    ]);

    // Class Methods
    Display.changeCursor = function (target, pixels, mask, hotx, hoty, w0, h0, cmap) {
        var w = w0;
        var h = h0;
        if (h < w) {
            h = w; // increase h to make it square
        } else {
            w = h; // increase w to make it square
        }

        var cur = [];

        // Push multi-byte little-endian values
        cur.push16le = function (num) {
            this.push(num & 0xFF, num >> 8 & 0xFF);
        };
        cur.push32le = function (num) {
            this.push(num & 0xFF, num >> 8 & 0xFF, num >> 16 & 0xFF, num >> 24 & 0xFF);
        };

        var IHDRsz = 40;
        var RGBsz = w * h * 4;
        var XORsz = Math.ceil(w * h / 8.0);
        var ANDsz = Math.ceil(w * h / 8.0);

        cur.push16le(0); // 0: Reserved
        cur.push16le(2); // 2: .CUR type
        cur.push16le(1); // 4: Number of images, 1 for non-animated ico

        // Cursor #1 header (ICONDIRENTRY)
        cur.push(w); // 6: width
        cur.push(h); // 7: height
        cur.push(0); // 8: colors, 0 -> true-color
        cur.push(0); // 9: reserved
        cur.push16le(hotx); // 10: hotspot x coordinate
        cur.push16le(hoty); // 12: hotspot y coordinate
        cur.push32le(IHDRsz + RGBsz + XORsz + ANDsz);
        // 14: cursor data byte size
        cur.push32le(22); // 18: offset of cursor data in the file

        // Cursor #1 InfoHeader (ICONIMAGE/BITMAPINFO)
        cur.push32le(IHDRsz); // 22: InfoHeader size
        cur.push32le(w); // 26: Cursor width
        cur.push32le(h * 2); // 30: XOR+AND height
        cur.push16le(1); // 34: number of planes
        cur.push16le(32); // 36: bits per pixel
        cur.push32le(0); // 38: Type of compression

        cur.push32le(XORsz + ANDsz);
        // 42: Size of Image
        cur.push32le(0); // 46: reserved
        cur.push32le(0); // 50: reserved
        cur.push32le(0); // 54: reserved
        cur.push32le(0); // 58: reserved

        // 62: color data (RGBQUAD icColors[])
        var y, x;
        for (y = h - 1; y >= 0; y--) {
            for (x = 0; x < w; x++) {
                if (x >= w0 || y >= h0) {
                    cur.push(0); // blue
                    cur.push(0); // green
                    cur.push(0); // red
                    cur.push(0); // alpha
                } else {
                    var idx = y * Math.ceil(w0 / 8) + Math.floor(x / 8);
                    var alpha = mask[idx] << x % 8 & 0x80 ? 255 : 0;
                    if (cmap) {
                        idx = w0 * y + x;
                        var rgb = cmap[pixels[idx]];
                        cur.push(rgb[2]); // blue
                        cur.push(rgb[1]); // green
                        cur.push(rgb[0]); // red
                        cur.push(alpha); // alpha
                    } else {
                        idx = (w0 * y + x) * 4;
                        cur.push(pixels[idx + 2]); // blue
                        cur.push(pixels[idx + 1]); // green
                        cur.push(pixels[idx]); // red
                        cur.push(alpha); // alpha
                    }
                }
            }
        }

        // XOR/bitmask data (BYTE icXOR[])
        // (ignored, just needs to be the right size)
        for (y = 0; y < h; y++) {
            for (x = 0; x < Math.ceil(w / 8); x++) {
                cur.push(0);
            }
        }

        // AND/bitmask data (BYTE icAND[])
        // (ignored, just needs to be the right size)
        for (y = 0; y < h; y++) {
            for (x = 0; x < Math.ceil(w / 8); x++) {
                cur.push(0);
            }
        }

        var url = 'data:image/x-icon;base64,' + _base2.default.encode(cur);
        target.style.cursor = 'url(' + url + ')' + hotx + ' ' + hoty + ', default';
    };
})();
module.exports = exports["default"];
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImRpc3BsYXkuanMiXSwibmFtZXMiOlsiRGlzcGxheSIsImRlZmF1bHRzIiwiX2RyYXdDdHgiLCJfY19mb3JjZUNhbnZhcyIsIl9yZW5kZXJRIiwiX2ZiX3dpZHRoIiwiX2ZiX2hlaWdodCIsIl9tYXhXaWR0aCIsIl9tYXhIZWlnaHQiLCJfdmlld3BvcnRMb2MiLCJfY2xlYW5SZWN0IiwiX3ByZXZEcmF3U3R5bGUiLCJfdGlsZSIsIl90aWxlMTZ4MTYiLCJfdGlsZV94IiwiX3RpbGVfeSIsInNldF9kZWZhdWx0cyIsIkRlYnVnIiwiX3RhcmdldCIsIkVycm9yIiwiZ2V0Q29udGV4dCIsIm5hdmlnYXRvciIsInVzZXJBZ2VudCIsIkVuZ2luZSIsImdlY2tvIiwid2Via2l0IiwidHJpZGVudCIsInByZXN0byIsImNsZWFyIiwiX3JlbmRlcl9tb2RlIiwiX3ByZWZlcl9qcyIsIkluZm8iLCJfY3Vyc29yX3VyaSIsInVuZGVmaW5lZCIsImJyb3dzZXJTdXBwb3J0c0N1cnNvclVSSXMiLCJTVVBQT1JUU19JTUFHRURBVEFfQ09OU1RSVUNUT1IiLCJJbWFnZURhdGEiLCJVaW50OENsYW1wZWRBcnJheSIsImV4IiwicHJvdG90eXBlIiwidmlld3BvcnRDaGFuZ2VQb3MiLCJkZWx0YVgiLCJkZWx0YVkiLCJ2cCIsIk1hdGgiLCJmbG9vciIsIl92aWV3cG9ydCIsInciLCJoIiwidngyIiwieCIsInZ5MiIsInkiLCJjciIsIngxIiwieDIiLCJ5MSIsInkyIiwic2F2ZVN0eWxlIiwiZmlsbFN0eWxlIiwiY2FudmFzIiwibW96SW1hZ2VTbW9vdGhpbmdFbmFibGVkIiwid2Via2l0SW1hZ2VTbW9vdGhpbmdFbmFibGVkIiwibXNJbWFnZVNtb290aGluZ0VuYWJsZWQiLCJpbWFnZVNtb290aGluZ0VuYWJsZWQiLCJkcmF3SW1hZ2UiLCJmaWxsUmVjdCIsInZpZXdwb3J0Q2hhbmdlU2l6ZSIsIndpZHRoIiwiaGVpZ2h0Iiwic2F2ZUltZyIsImltZ193aWR0aCIsImltZ19oZWlnaHQiLCJnZXRJbWFnZURhdGEiLCJzdHlsZSIsInB1dEltYWdlRGF0YSIsImdldENsZWFuRGlydHlSZXNldCIsImNsZWFuQm94IiwiZGlydHlCb3hlcyIsInB1c2giLCJhYnNYIiwiYWJzWSIsInJlc2l6ZSIsIl9yZXNjYWxlIiwiX3NjYWxlIiwiX2xvZ28iLCJibGl0U3RyaW5nSW1hZ2UiLCJkYXRhIiwiY2xlYXJSZWN0IiwiY29sb3IiLCJmcm9tX3F1ZXVlIiwibGVuZ3RoIiwicmVuZGVyUV9wdXNoIiwiX3NldEZpbGxDb2xvciIsImNvcHlJbWFnZSIsIm9sZF94Iiwib2xkX3kiLCJuZXdfeCIsIm5ld195Iiwic3RhcnRUaWxlIiwiY3JlYXRlSW1hZ2VEYXRhIiwiYmdyIiwiX3RydWVfY29sb3IiLCJfY29sb3VyTWFwIiwicmVkIiwiZ3JlZW4iLCJibHVlIiwiaSIsInN1YlRpbGUiLCJ4ZW5kIiwieWVuZCIsImoiLCJwIiwiZmluaXNoVGlsZSIsImJsaXRJbWFnZSIsImFyciIsIm9mZnNldCIsIm5ld19hcnIiLCJVaW50OEFycmF5Iiwic2V0IiwiYnVmZmVyIiwiX2JncnhJbWFnZURhdGEiLCJfY21hcEltYWdlRGF0YSIsImJsaXRSZ2JJbWFnZSIsIl9yZ2JJbWFnZURhdGEiLCJibGl0UmdieEltYWdlIiwiX3JnYnhJbWFnZURhdGEiLCJzdHIiLCJpbWciLCJJbWFnZSIsIm9ubG9hZCIsImJpbmQiLCJzcmMiLCJhY3Rpb24iLCJfc2Nhbl9yZW5kZXJRIiwiY2hhbmdlQ3Vyc29yIiwicGl4ZWxzIiwibWFzayIsImhvdHgiLCJob3R5IiwiV2FybiIsImRlZmF1bHRDdXJzb3IiLCJjdXJzb3IiLCJkaXNhYmxlTG9jYWxDdXJzb3IiLCJjbGlwcGluZ0Rpc3BsYXkiLCJmYkNsaXAiLCJsaW1pdGVkVnAiLCJjbGlwcGluZyIsImdldF9jb250ZXh0Iiwic2V0X3NjYWxlIiwic2NhbGUiLCJzZXRfd2lkdGgiLCJnZXRfd2lkdGgiLCJzZXRfaGVpZ2h0IiwiZ2V0X2hlaWdodCIsImF1dG9zY2FsZSIsImNvbnRhaW5lcldpZHRoIiwiY29udGFpbmVySGVpZ2h0IiwiZG93bnNjYWxlT25seSIsInRhcmdldEFzcGVjdFJhdGlvIiwiZmJBc3BlY3RSYXRpbyIsInNjYWxlUmF0aW8iLCJ0YXJnZXRXIiwidGFyZ2V0SCIsInJvdW5kIiwiZmFjdG9yIiwibWluIiwibmV3U3R5bGUiLCJ2eCIsInZ5IiwiYnl0ZU9mZnNldCIsImNtYXAiLCJyZWFkeSIsImEiLCJ0eXBlIiwiY29tcGxldGUiLCJzaGlmdCIsInJlcXVlc3RBbmltYXRpb25GcmFtZSIsIm1ha2VfcHJvcGVydGllcyIsInRhcmdldCIsIncwIiwiaDAiLCJjdXIiLCJwdXNoMTZsZSIsIm51bSIsInB1c2gzMmxlIiwiSUhEUnN6IiwiUkdCc3oiLCJYT1JzeiIsImNlaWwiLCJBTkRzeiIsImlkeCIsImFscGhhIiwicmdiIiwidXJsIiwiZW5jb2RlIl0sIm1hcHBpbmdzIjoiOzs7OztrQkFnQndCQSxPOztBQUp4Qjs7OztBQUNBOzs7Ozs7QUFiQTs7Ozs7Ozs7O0FBU0E7QUFDQTs7QUFNZSxTQUFTQSxPQUFULENBQWlCQyxRQUFqQixFQUEyQjtBQUN0QyxTQUFLQyxRQUFMLEdBQWdCLElBQWhCO0FBQ0EsU0FBS0MsY0FBTCxHQUFzQixLQUF0Qjs7QUFFQSxTQUFLQyxRQUFMLEdBQWdCLEVBQWhCLENBSnNDLENBSWpCOztBQUVyQjtBQUNBLFNBQUtDLFNBQUwsR0FBaUIsQ0FBakI7QUFDQSxTQUFLQyxVQUFMLEdBQWtCLENBQWxCOztBQUVBO0FBQ0EsU0FBS0MsU0FBTCxHQUFpQixDQUFqQjtBQUNBLFNBQUtDLFVBQUwsR0FBa0IsQ0FBbEI7O0FBRUE7QUFDQSxTQUFLQyxZQUFMLEdBQW9CLEVBQUUsS0FBSyxDQUFQLEVBQVUsS0FBSyxDQUFmLEVBQWtCLEtBQUssQ0FBdkIsRUFBMEIsS0FBSyxDQUEvQixFQUFwQjtBQUNBLFNBQUtDLFVBQUwsR0FBa0IsRUFBRSxNQUFNLENBQVIsRUFBVyxNQUFNLENBQWpCLEVBQW9CLE1BQU0sQ0FBQyxDQUEzQixFQUE4QixNQUFN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SixDQUFTLENBQVQ7QUFDSDtBQUNKOztBQUVEO0FBQ0E7QUFDQSxhQUFLM0IsSUFBSSxDQUFULEVBQVlBLElBQUlKLENBQWhCLEVBQW1CSSxHQUFuQixFQUF3QjtBQUNwQixpQkFBS0YsSUFBSSxDQUFULEVBQVlBLElBQUlOLEtBQUtpSixJQUFMLENBQVU5SSxJQUFJLENBQWQsQ0FBaEIsRUFBa0NHLEdBQWxDLEVBQXVDO0FBQ25Db0ksb0JBQUl2RyxJQUFKLENBQVMsQ0FBVDtBQUNIO0FBQ0o7O0FBRUQsWUFBSW1ILE1BQU0sOEJBQThCLGVBQU9DLE1BQVAsQ0FBY2IsR0FBZCxDQUF4QztBQUNBSCxlQUFPekcsS0FBUCxDQUFhb0UsTUFBYixHQUFzQixTQUFTb0QsR0FBVCxHQUFlLEdBQWYsR0FBcUJ4RCxJQUFyQixHQUE0QixHQUE1QixHQUFrQ0MsSUFBbEMsR0FBeUMsV0FBL0Q7QUFDSCxLQXpHRDtBQTBHSCxDQS95QkQiLCJmaWxlIjoiZGlzcGxheS5qcyIsInNvdXJjZXNDb250ZW50IjpbIi8qXG4gKiBub1ZOQzogSFRNTDUgVk5DIGNsaWVudFxuICogQ29weXJpZ2h0IChDKSAyMDEyIEpvZWwgTWFydGluXG4gKiBDb3B5cmlnaHQgKEMpIDIwMTUgU2FtdWVsIE1hbm5laGVkIGZvciBDZW5kaW8gQUJcbiAqIExpY2Vuc2VkIHVuZGVyIE1QTCAyLjAgKHNlZSBMSUNFTlNFLnR4dClcbiAqXG4gKiBTZWUgUkVBRE1FLm1kIGZvciB1c2FnZSBhbmQgaW50ZWdyYXRpb24gaW5zdHJ1Y3Rpb25zLlxuICovXG5cbi8qanNsaW50IGJyb3dzZXI6IHRydWUsIHdoaXRlOiBmYWxzZSAqL1xuLypnbG9iYWwgVXRpbCwgQmFzZTY0LCBjaGFuZ2VDdXJzb3IgKi9cblxuaW1wb3J0IFV0aWwgZnJvbSBcIi4vdXRpbFwiO1xuaW1wb3J0IEJhc2U2NCBmcm9tIFwiLi9iYXNlNjRcIjtcblxuXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbiBEaXNwbGF5KGRlZmF1bHRzKSB7XG4gICAgdGhpcy5fZHJhd0N0eCA9IG51bGw7XG4gICAgdGhpcy5fY19mb3JjZUNhbnZhcyA9IGZhbHNlO1xuXG4gICAgdGhpcy5fcmVuZGVyUSA9IFtdOyAgLy8gcXVldWUgZHJhd2luZyBhY3Rpb25zIGZvciBpbi1vZGVyIHJlbmRlcmluZ1xuXG4gICAgLy8gdGhlIGZ1bGwgZnJhbWUgYnVmZmVyIChsb2dpY2FsIGNhbnZhcykgc2l6ZVxuICAgIHRoaXMuX2ZiX3dpZHRoID0gMDtcbiAgICB0aGlzLl9mYl9oZWlnaHQgPSAwO1xuXG4gICAgLy8gdGhlIHNpemUgbGltaXQgb2YgdGhlIHZpZXdwb3J0IChzdGFydCBkaXNhYmxlZClcbiAgICB0aGlzLl9tYXhXaWR0aCA9IDA7XG4gICAgdGhpcy5fbWF4SGVpZ2h0ID0gMDtcblxuICAgIC8vIHRoZSB2aXNpYmxlIFwicGh5c2ljYWwgY2FudmFzXCIgdmlld3BvcnRcbiAgICB0aGlzLl92aWV3cG9ydExvYyA9IHsgJ3gnOiAwLCAneSc6IDAsICd3JzogMCwgJ2gnOiAwIH07XG4gICAgdGhpcy5fY2xlYW5SZWN0ID0geyAneDEnOiAwLCAneTEnOiAwLCAneDInOiAtMSwgJ3kyJzogLTEgfTtcblxuICAgIHRoaXMuX3ByZXZEcmF3U3R5bGUgPSBcIlwiO1xuICAgIHRoaXMuX3RpbGUgPSBudWxsO1xuICAgIHRoaXMuX3RpbGUxNngxNiA9IG51bGw7XG4gICAgdGhpcy5fdGlsZV94ID0gMDtcbiAgICB0aGlzLl90aWxlX3kgPSAwO1xuXG4gICAgVXRpbC5zZXRfZGVmYXVsdHModGhpcywgZGVmYXVsdHMsIHtcbiAgICAgICAgJ3RydWVfY29sb3InOiB0cnVlLFxuICAgICAgICAnY29sb3VyTWFwJzogW10sXG4gICAgICAgICdzY2FsZSc6IDEuMCxcbiAgICAgICAgJ3ZpZXdwb3J0JzogZmFsc2UsXG4gICAgICAgICdyZW5kZXJfbW9kZSc6ICcnXG4gICAgfSk7XG5cbiAgICBVdGlsLkRlYnVnKFwiPj4gRGlzcGxheS5jb25zdHJ1Y3RvclwiKTtcblxuICAgIGlmICghdGhpcy5fdGFyZ2V0KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIlRhcmdldCBtdXN0IGJlIHNldFwiKTtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIHRoaXMuX3RhcmdldCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YXJnZXQgbXVzdCBiZSBhIERPTSBlbGVtZW50Jyk7XG4gICAgfVxuXG4gICAgaWYgKCF0aGlzLl90YXJnZXQuZ2V0Q29udGV4dCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJubyBnZXRDb250ZXh0IG1ldGhvZFwiKTtcbiAgICB9XG5cbiAgICBpZiAoIXRoaXMuX2RyYXdDdHgpIHtcbiAgICAgICAgdGhpcy5fZHJhd0N0eCA9IHRoaXMuX3RhcmdldC5nZXRDb250ZXh0KCcyZCcpO1xuICAgIH1cblxuICAgIFV0aWwuRGVidWcoXCJVc2VyIEFnZW50OiBcIiArIG5hdmlnYXRvci51c2VyQWdlbnQpO1xuICAgIGlmIChVdGlsLkVuZ2luZS5nZWNrbykgeyBVdGlsLkRlYnVnKFwiQnJvd3NlcjogZ2Vja28gXCIgKyBVdGlsLkVuZ2luZS5nZWNrbyk7IH1cbiAgICBpZiAoVXRpbC5FbmdpbmUud2Via2l0KSB7IFV0aWwuRGVidWcoXCJCcm93c2VyOiB3ZWJraXQgXCIgKyBVdGlsLkVuZ2luZS53ZWJraXQpOyB9XG4gICAgaWYgKFV0aWwuRW5naW5lLnRyaWRlbnQpIHsgVXRpbC5EZWJ1ZyhcIkJyb3dzZXI6IHRyaWRlbnQgXCIgKyBVdGlsLkVuZ2luZS50cmlkZW50KTsgfVxuICAgIGlmIChVdGlsLkVuZ2luZS5wcmVzdG8pIHsgVXRpbC5EZWJ1ZyhcIkJyb3dzZXI6IHByZXN0byBcIiArIFV0aWwuRW5naW5lLnByZXN0byk7IH1cblxuICAgIHRoaXMuY2xlYXIoKTtcblxuICAgIC8vIENoZWNrIGNhbnZhcyBmZWF0dXJlc1xuICAgIGlmICgnY3JlYXRlSW1hZ2VEYXRhJyBpbiB0aGlzLl9kcmF3Q3R4KSB7XG4gICAgICAgIHRoaXMuX3JlbmRlcl9tb2RlID0gJ2NhbnZhcyByZW5kZXJpbmcnO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkNhbnZhcyBkb2VzIG5vdCBzdXBwb3J0IGNyZWF0ZUltYWdlRGF0YVwiKTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5fcHJlZmVyX2pzID09PSBudWxsKSB7XG4gICAgICAgIFV0aWwuSW5mbyhcIlByZWZlcmluZyBqYXZhc2NyaXB0IG9wZXJhdGlvbnNcIik7XG4gICAgICAgIHRoaXMuX3ByZWZlcl9qcyA9IHRydWU7XG4gICAgfVxuXG4gICAgLy8gRGV0ZXJtaW5lIGJyb3dzZXIgc3VwcG9ydCBmb3Igc2V0dGluZyB0aGUgY3Vyc29yIHZpYSBkYXRhIFVSSSBzY2hlbWVcbiAgICBpZiAodGhpcy5fY3Vyc29yX3VyaSB8fCB0aGlzLl9jdXJzb3JfdXJpID09PSBudWxsIHx8XG4gICAgICAgICAgICB0aGlzLl9jdXJzb3JfdXJpID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdGhpcy5fY3Vyc29yX3VyaSA9IFV0aWwuYnJvd3NlclN1cHBvcnRzQ3Vyc29yVVJJcygpO1xuICAgIH1cblxuICAgIFV0aWwuRGVidWcoXCI8PCBEaXNwbGF5LmNvbnN0cnVjdG9yXCIpO1xufTtcblxuKGZ1bmN0aW9uICgpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcblxuICAgIHZhciBTVVBQT1JUU19JTUFHRURBVEFfQ09OU1RSVUNUT1IgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgICBuZXcgSW1hZ2VEYXRhKG5ldyBVaW50OENsYW1wZWRBcnJheSg0KSwgMSwgMSk7XG4gICAgICAgIFNVUFBPUlRTX0lNQUdFREFUQV9DT05TVFJVQ1RPUiA9IHRydWU7XG4gICAgfSBjYXRjaCAoZXgpIHtcbiAgICAgICAgLy8gaWdub3JlIGZhaWx1cmVcbiAgICB9XG5cblxuICAgIERpc3BsYXkucHJvdG90eXBlID0ge1xuICAgICAgICAvLyBQdWJsaWMgbWV0aG9kc1xuICAgICAgICB2aWV3cG9ydENoYW5nZVBvczogZnVuY3Rpb24gKGRlbHRhWCwgZGVsdGFZKSB7XG4gICAgICAgICAgICB2YXIgdnAgPSB0aGlzLl92aWV3cG9ydExvYztcbiAgICAgICAgICAgIGRlbHRhWCA9IE1hdGguZmxvb3IoZGVsdGFYKTtcbiAgICAgICAgICAgIGRlbHRhWSA9IE1hdGguZmxvb3IoZGVsdGFZKTtcblxuICAgICAgICAgICAgaWYgKCF0aGlzLl92aWV3cG9ydCkge1xuICAgICAgICAgICAgICAgIGRlbHRhWCA9IC12cC53OyAgLy8gY2xhbXBlZCBsYXRlciBvZiBvdXQgb2YgYm91bmRzXG4gICAgICAgICAgICAgICAgZGVsdGFZID0gLXZwLmg7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHZhciB2eDIgPSB2cC54ICsgdnAudyAtIDE7XG4gICAgICAgICAgICB2YXIgdnkyID0gdnAueSArIHZwLmggLSAxO1xuXG4gICAgICAgICAgICAvLyBQb3NpdGlvbiBjaGFuZ2VcblxuICAgICAgICAgICAgaWYgKGRlbHRhWCA8IDAgJiYgdnAueCArIGRlbHRhWCA8IDApIHtcbiAgICAgICAgICAgICAgICBkZWx0YVggPSAtdnAueDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh2eDIgKyBkZWx0YVggPj0gdGhpcy5fZmJfd2lkdGgpIHtcbiAgICAgICAgICAgICAgICBkZWx0YVggLT0gdngyICsgZGVsdGFYIC0gdGhpcy5fZmJfd2lkdGggKyAxO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodnAueSArIGRlbHRhWSA8IDApIHtcbiAgICAgICAgICAgICAgICBkZWx0YVkgPSAtdnAueTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh2eTIgKyBkZWx0YVkgPj0gdGhpcy5fZmJfaGVpZ2h0KSB7XG4gICAgICAgICAgICAgICAgZGVsdGFZIC09ICh2eTIgKyBkZWx0YVkgLSB0aGlzLl9mYl9oZWlnaHQgKyAxKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGRlbHRhWCA9PT0gMCAmJiBkZWx0YVkgPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBVdGlsLkRlYnVnKFwidmlld3BvcnRDaGFuZ2UgZGVsdGFYOiBcIiArIGRlbHRhWCArIFwiLCBkZWx0YVk6IFwiICsgZGVsdGFZKTtcblxuICAgICAgICAgICAgdnAueCArPSBkZWx0YVg7XG4gICAgICAgICAgICB2eDIgKz0gZGVsdGFYO1xuICAgICAgICAgICAgdnAueSArPSBkZWx0YVk7XG4gICAgICAgICAgICB2eTIgKz0gZGVsdGFZO1xuXG4gICAgICAgICAgICAvLyBVcGRhdGUgdGhlIGNsZWFuIHJlY3RhbmdsZVxuICAgICAgICAgICAgdmFyIGNyID0gdGhpcy5fY2xlYW5SZWN0O1xuICAgICAgICAgICAgaWYgKHZwLnggPiBjci54MSkge1xuICAgICAgICAgICAgICAgIGNyLngxID0gdnAueDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh2eDIgPCBjci54Mikge1xuICAgICAgICAgICAgICAgIGNyLngyID0gdngyO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHZwLnkgPiBjci55MSkge1xuICAgICAgICAgICAgICAgIGNyLnkxID0gdnAueTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh2eTIgPCBjci55Mikge1xuICAgICAgICAgICAgICAgIGNyLnkyID0gdnkyO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YXIgeDEsIHc7XG4gICAgICAgICAgICBpZiAoZGVsdGFYIDwgMCkge1xuICAgICAgICAgICAgICAgIC8vIFNoaWZ0IHZpZXdwb3J0IGxlZnQsIHJlZHJhdyBsZWZ0IHNlY3Rpb25cbiAgICAgICAgICAgICAgICB4MSA9IDA7XG4gICAgICAgICAgICAgICAgdyA9IC1kZWx0YVg7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIFNoaWZ0IHZpZXdwb3J0IHJpZ2h0LCByZWRyYXcgcmlnaHQgc2VjdGlvblxuICAgICAgICAgICAgICAgIHgxID0gdnAudyAtIGRlbHRhWDtcbiAgICAgICAgICAgICAgICB3ID0gZGVsdGFYO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YXIgeTEsIGg7XG4gICAgICAgICAgICBpZiAoZGVsdGFZIDwgMCkge1xuICAgICAgICAgICAgICAgIC8vIFNoaWZ0IHZpZXdwb3J0IHVwLCByZWRyYXcgdG9wIHNlY3Rpb25cbiAgICAgICAgICAgICAgICB5MSA9IDA7XG4gICAgICAgICAgICAgICAgaCA9IC1kZWx0YVk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIFNoaWZ0IHZpZXdwb3J0IGRvd24sIHJlZHJhdyBib3R0b20gc2VjdGlvblxuICAgICAgICAgICAgICAgIHkxID0gdnAuaCAtIGRlbHRhWTtcbiAgICAgICAgICAgICAgICBoID0gZGVsdGFZO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YXIgc2F2ZVN0eWxlID0gdGhpcy5fZHJhd0N0eC5maWxsU3R5bGU7XG4gICAgICAgICAgICB2YXIgY2FudmFzID0gdGhpcy5fdGFyZ2V0O1xuICAgICAgICAgICAgdGhpcy5fZHJhd0N0eC5maWxsU3R5bGUgPSBcInJnYigyNTUsMjU1LDI1NSlcIjtcblxuICAgICAgICAgICAgLy8gRHVlIHRvIHRoaXMgYnVnIGFtb25nIG90aGVycyBbMV0gd2UgbmVlZCB0byBkaXNhYmxlIHRoZSBpbWFnZS1zbW9vdGhpbmcgdG9cbiAgICAgICAgICAgIC8vIGF2b2lkIGdldHRpbmcgYSBibHVyIGVmZmVjdCB3aGVuIHBhbm5pbmcuXG4gICAgICAgICAgICAvL1xuICAgICAgICAgICAgLy8gMS4gaHR0cHM6Ly9idWd6aWxsYS5tb3ppbGxhLm9yZy9zaG93X2J1Zy5jZ2k/aWQ9MTE5NDcxOVxuICAgICAgICAgICAgLy9cbiAgICAgICAgICAgIC8vIFdlIG5lZWQgdG8gc2V0IHRoZXNlIGV2ZXJ5IHRpbWUgc2luY2UgYWxsIHByb3BlcnRpZXMgYXJlIHJlc2V0XG4gICAgICAgICAgICAvLyB3aGVuIHRoZSB0aGUgc2l6ZSBpcyBjaGFuZ2VkXG4gICAgICAgICAgICBpZiAodGhpcy5fZHJhd0N0eC5tb3pJbWFnZVNtb290aGluZ0VuYWJsZWQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9kcmF3Q3R4Lm1vekltYWdlU21vb3RoaW5nRW5hYmxlZCA9IGZhbHNlO1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLl9kcmF3Q3R4LndlYmtpdEltYWdlU21vb3RoaW5nRW5hYmxlZCkge1xuICAgICAgICAgICAgICAgIHRoaXMuX2RyYXdDdHgud2Via2l0SW1hZ2VTbW9vdGhpbmdFbmFibGVkID0gZmFsc2U7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMuX2RyYXdDdHgubXNJbWFnZVNtb290aGluZ0VuYWJsZWQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9kcmF3Q3R4Lm1zSW1hZ2VTbW9vdGhpbmdFbmFibGVkID0gZmFsc2U7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMuX2RyYXdDdHguaW1hZ2VTbW9vdGhpbmdFbmFibGVkKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fZHJhd0N0eC5pbWFnZVNtb290aGluZ0VuYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gQ29weSB0aGUgdmFsaWQgcGFydCBvZiB0aGUgdmlld3BvcnQgdG8gdGhlIHNoaWZ0ZWQgbG9jYXRpb25cbiAgICAgICAgICAgIHRoaXMuX2RyYXdDdHguZHJhd0ltYWdlKGNhbnZhcywgMCwgMCwgdnAudywgdnAuaCwgLWRlbHRhWCwgLWRlbHRhWSwgdnAudywgdnAuaCk7XG5cbiAgICAgICAgICAgIGlmIChkZWx0YVggIT09IDApIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9kcmF3Q3R4LmZpbGxSZWN0KHgxLCAwLCB3LCB2cC5oKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChkZWx0YVkgIT09IDApIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9kcmF3Q3R4LmZpbGxSZWN0KDAsIHkxLCB2cC53LCBoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMuX2RyYXdDdHguZmlsbFN0eWxlID0gc2F2ZVN0eWxlO1xuICAgICAgICB9LFxuXG4gICAgICAgIHZpZXdwb3J0Q2hhbmdlU2l6ZTogZnVuY3Rpb24od2lkdGgsIGhlaWdodCkge1xuXG4gICAgICAgICAgICBpZiAodHlwZW9mKHdpZHRoKSA9PT0gXCJ1bmRlZmluZWRcIiB8fCB0eXBlb2YoaGVpZ2h0KSA9PT0gXCJ1bmRlZmluZWRcIikge1xuXG4gICAgICAgICAgICAgICAgVXRpbC5EZWJ1ZyhcIlNldHRpbmcgdmlld3BvcnQgdG8gZnVsbCBkaXNwbGF5IHJlZ2lvblwiKTtcbiAgICAgICAgICAgICAgICB3aWR0aCA9IHRoaXMuX2ZiX3dpZHRoO1xuICAgICAgICAgICAgICAgIGhlaWdodCA9IHRoaXMuX2ZiX2hlaWdodDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFyIHZwID0gdGhpcy5fdmlld3BvcnRMb2M7XG4gICAgICAgICAgICBpZiAodnAudyAhPT0gd2lkdGggfHwgdnAuaCAhPT0gaGVpZ2h0KSB7XG5cbiAgICAgICAgICAgICAgICBpZiAodGhpcy5fdmlld3BvcnQpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX21heFdpZHRoICE9PSAwICYmIHdpZHRoID4gdGhpcy5fbWF4V2lkdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHdpZHRoID0gdGhpcy5fbWF4V2lkdGg7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX21heEhlaWdodCAhPT0gMCAmJiBoZWlnaHQgPiB0aGlzLl9tYXhIZWlnaHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGhlaWdodCA9IHRoaXMuX21heEhlaWdodDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHZhciBjciA9IHRoaXMuX2NsZWFuUmVjdDtcblxuICAgICAgICAgICAgICAgIGlmICh3aWR0aCA8IHZwLncgJiYgIGNyLngyID4gdnAueCArIHdpZHRoIC0gMSkge1xuICAgICAgICAgICAgICAgICAgICBjci54MiA9IHZwLnggKyB3aWR0aCAtIDE7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChoZWlnaHQgPCB2cC5oICYmICBjci55MiA+IHZwLnkgKyBoZWlnaHQgLSAxKSB7XG4gICAgICAgICAgICAgICAgICAgIGNyLnkyID0gdnAueSArIGhlaWdodCAtIDE7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdnAudyA9IHdpZHRoO1xuICAgICAgICAgICAgICAgIHZwLmggPSBoZWlnaHQ7XG5cbiAgICAgICAgICAgICAgICB2YXIgY2FudmFzID0gdGhpcy5fdGFyZ2V0O1xuICAgICAgICAgICAgICAgIGlmIChjYW52YXMud2lkdGggIT09IHdpZHRoIHx8IGNhbnZhcy5oZWlnaHQgIT09IGhlaWdodCkge1xuXG4gICAgICAgICAgICAgICAgICAgIC8vIFdlIGhhdmUgdG8gc2F2ZSB0aGUgY2FudmFzIGRhdGEgc2luY2UgY2hhbmdpbmcgdGhlIHNpemUgd2lsbCBjbGVhciBpdFxuICAgICAgICAgICAgICAgICAgICB2YXIgc2F2ZUltZyA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIGlmICh2cC53ID4gMCAmJiB2cC5oID4gMCAmJiBjYW52YXMud2lkdGggPiAwICYmIGNhbnZhcy5oZWlnaHQgPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB2YXIgaW1nX3dpZHRoID0gY2FudmFzLndpZHRoIDwgdnAudyA/IGNhbnZhcy53aWR0aCA6IHZwLnc7XG4gICAgICAgICAgICAgICAgICAgICAgICB2YXIgaW1nX2hlaWdodCA9IGNhbnZhcy5oZWlnaHQgPCB2cC5oID8gY2FudmFzLmhlaWdodCA6IHZwLmg7XG4gICAgICAgICAgICAgICAgICAgICAgICBzYXZlSW1nID0gdGhpcy5fZHJhd0N0eC5nZXRJbWFnZURhdGEoMCwgMCwgaW1nX3dpZHRoLCBpbWdfaGVpZ2h0KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmIChjYW52YXMud2lkdGggIT09IHdpZHRoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYW52YXMud2lkdGggPSB3aWR0aDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhbnZhcy5zdHlsZS53aWR0aCA9IHdpZHRoICsgJ3B4JztcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBpZiAoY2FudmFzLmhlaWdodCAhPT0gaGVpZ2h0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYW52YXMuaGVpZ2h0ID0gaGVpZ2h0O1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FudmFzLnN0eWxlLmhlaWdodCA9IGhlaWdodCArICdweCc7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoc2F2ZUltZykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZHJhd0N0eC5wdXRJbWFnZURhdGEoc2F2ZUltZywgMCwgMCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gUmV0dXJuIGEgbWFwIG9mIGNsZWFuIGFuZCBkaXJ0eSBhcmVhcyBvZiB0aGUgdmlld3BvcnQgYW5kIHJlc2V0IHRoZVxuICAgICAgICAvLyB0cmFja2luZyBvZiBjbGVhbiBhbmQgZGlydHkgYXJlYXNcbiAgICAgICAgLy9cbiAgICAgICAgLy8gUmV0dXJuczogeyAnY2xlYW5Cb3gnOiB7ICd4JzogeCwgJ3knOiB5LCAndyc6IHcsICdoJzogaH0sXG4gICAgICAgIC8vICAgICAgICAgICAgJ2RpcnR5Qm94ZXMnOiBbeyAneCc6IHgsICd5JzogeSwgJ3cnOiB3LCAnaCc6IGggfSwgLi4uXSB9XG4gICAgICAgIGdldENsZWFuRGlydHlSZXNldDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdmFyIHZwID0gdGhpcy5fdmlld3BvcnRMb2M7XG4gICAgICAgICAgICB2YXIgY3IgPSB0aGlzLl9jbGVhblJlY3Q7XG5cbiAgICAgICAgICAgIHZhciBjbGVhbkJveCA9IHsgJ3gnOiBjci54MSwgJ3knOiBjci55MSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ3cnOiBjci54MiAtIGNyLngxICsgMSwgJ2gnOiBjci55MiAtIGNyLnkxICsgMSB9O1xuXG4gICAgICAgICAgICB2YXIgZGlydHlCb3hlcyA9IFtdO1xuICAgICAgICAgICAgaWYgKGNyLngxID49IGNyLngyIHx8IGNyLnkxID49IGNyLnkyKSB7XG4gICAgICAgICAgICAgICAgLy8gV2hvbGUgdmlld3BvcnQgaXMgZGlydHlcbiAgICAgICAgICAgICAgICBkaXJ0eUJveGVzLnB1c2goeyAneCc6IHZwLngsICd5JzogdnAueSwgJ3cnOiB2cC53LCAnaCc6IHZwLmggfSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIFJlZHJhdyBkaXJ0eSByZWdpb25zXG4gICAgICAgICAgICAgICAgdmFyIHZ4MiA9IHZwLnggKyB2cC53IC0gMTtcbiAgICAgICAgICAgICAgICB2YXIgdnkyID0gdnAueSArIHZwLmggLSAxO1xuXG4gICAgICAgICAgICAgICAgaWYgKHZwLnggPCBjci54MSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBsZWZ0IHNpZGUgZGlydHkgcmVnaW9uXG4gICAgICAgICAgICAgICAgICAgIGRpcnR5Qm94ZXMucHVzaCh7J3gnOiB2cC54LCAneSc6IHZwLnksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ3cnOiBjci54MSAtIHZwLnggKyAxLCAnaCc6IHZwLmh9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKHZ4MiA+IGNyLngyKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIHJpZ2h0IHNpZGUgZGlydHkgcmVnaW9uXG4gICAgICAgICAgICAgICAgICAgIGRpcnR5Qm94ZXMucHVzaCh7J3gnOiBjci54MiArIDEsICd5JzogdnAueSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAndyc6IHZ4MiAtIGNyLngyLCAnaCc6IHZwLmh9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYodnAueSA8IGNyLnkxKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIHRvcC9taWRkbGUgZGlydHkgcmVnaW9uXG4gICAgICAgICAgICAgICAgICAgIGRpcnR5Qm94ZXMucHVzaCh7J3gnOiBjci54MSwgJ3knOiB2cC55LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICd3JzogY3IueDIgLSBjci54MSArIDEsICdoJzogY3IueTEgLSB2cC55fSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmICh2eTIgPiBjci55Mikge1xuICAgICAgICAgICAgICAgICAgICAvLyBib3R0b20vbWlkZGxlIGRpcnR5IHJlZ2lvblxuICAgICAgICAgICAgICAgICAgICBkaXJ0eUJveGVzLnB1c2goeyd4JzogY3IueDEsICd5JzogY3IueTIgKyAxLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICd3JzogY3IueDIgLSBjci54MSArIDEsICdoJzogdnkyIC0gY3IueTJ9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuX2NsZWFuUmVjdCA9IHsneDEnOiB2cC54LCAneTEnOiB2cC55LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICd4Mic6IHZwLnggKyB2cC53IC0gMSwgJ3kyJzogdnAueSArIHZwLmggLSAxfTtcblxuICAgICAgICAgICAgcmV0dXJuIHsnY2xlYW5Cb3gnOiBjbGVhbkJveCwgJ2RpcnR5Qm94ZXMnOiBkaXJ0eUJveGVzfTtcbiAgICAgICAgfSxcblxuICAgICAgICBhYnNYOiBmdW5jdGlvbiAoeCkge1xuICAgICAgICAgICAgcmV0dXJuIHggKyB0aGlzLl92aWV3cG9ydExvYy54O1xuICAgICAgICB9LFxuXG4gICAgICAgIGFic1k6IGZ1bmN0aW9uICh5KSB7XG4gICAgICAgICAgICByZXR1cm4geSArIHRoaXMuX3ZpZXdwb3J0TG9jLnk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgcmVzaXplOiBmdW5jdGlvbiAod2lkdGgsIGhlaWdodCkge1xuICAgICAgICAgICAgdGhpcy5fcHJldkRyYXdTdHlsZSA9IFwiXCI7XG5cbiAgICAgICAgICAgIHRoaXMuX2ZiX3dpZHRoID0gd2lkdGg7XG4gICAgICAgICAgICB0aGlzLl9mYl9oZWlnaHQgPSBoZWlnaHQ7XG5cbiAgICAgICAgICAgIHRoaXMuX3Jlc2NhbGUodGhpcy5fc2NhbGUpO1xuXG4gICAgICAgICAgICB0aGlzLnZpZXdwb3J0Q2hhbmdlU2l6ZSgpO1xuICAgICAgICB9LFxuXG4gICAgICAgIGNsZWFyOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fbG9nbykge1xuICAgICAgICAgICAgICAgIHRoaXMucmVzaXplKHRoaXMuX2xvZ28ud2lkdGgsIHRoaXMuX2xvZ28uaGVpZ2h0KTtcbiAgICAgICAgICAgICAgICB0aGlzLmJsaXRTdHJpbmdJbWFnZSh0aGlzLl9sb2dvLmRhdGEsIDAsIDApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpZiAoVXRpbC5FbmdpbmUudHJpZGVudCA9PT0gNikge1xuICAgICAgICAgICAgICAgICAgICAvLyBOQihkaXJlY3R4bWFuMTIpOiB0aGVyZSdzIGEgYnVnIGluIElFMTAgd2hlcmUgd2UgY2FuIGZhaWwgdG8gYWN0dWFsbHlcbiAgICAgICAgICAgICAgICAgICAgLy8gICAgICAgICAgICAgICAgICAgY2xlYXIgdGhlIGNhbnZhcyBoZXJlIGJlY2F1c2Ugb2YgdGhlIHJlc2l6ZS5cbiAgICAgICAgICAgICAgICAgICAgLy8gICAgICAgICAgICAgICAgICAgQ2xlYXJpbmcgdGhlIGN1cnJlbnQgdmlld3BvcnQgZmlyc3QgZml4ZXMgdGhlIGlzc3VlXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2RyYXdDdHguY2xlYXJSZWN0KDAsIDAsIHRoaXMuX3ZpZXdwb3J0TG9jLncsIHRoaXMuX3ZpZXdwb3J0TG9jLmgpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aGlzLnJlc2l6ZSgyNDAsIDIwKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9kcmF3Q3R4LmNsZWFyUmVjdCgwLCAwLCB0aGlzLl92aWV3cG9ydExvYy53LCB0aGlzLl92aWV3cG9ydExvYy5oKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhpcy5fcmVuZGVyUSA9IFtdO1xuICAgICAgICB9LFxuXG4gICAgICAgIGZpbGxSZWN0OiBmdW5jdGlvbiAoeCwgeSwgd2lkdGgsIGhlaWdodCwgY29sb3IsIGZyb21fcXVldWUpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9yZW5kZXJRLmxlbmd0aCAhPT0gMCAmJiAhZnJvbV9xdWV1ZSkge1xuICAgICAgICAgICAgICAgIHRoaXMucmVuZGVyUV9wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgJ3R5cGUnOiAnZmlsbCcsXG4gICAgICAgICAgICAgICAgICAgICd4JzogeCxcbiAgICAgICAgICAgICAgICAgICAgJ3knOiB5LFxuICAgICAgICAgICAgICAgICAgICAnd2lkdGgnOiB3aWR0aCxcbiAgICAgICAgICAgICAgICAgICAgJ2hlaWdodCc6IGhlaWdodCxcbiAgICAgICAgICAgICAgICAgICAgJ2NvbG9yJzogY29sb3JcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fc2V0RmlsbENvbG9yKGNvbG9yKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9kcmF3Q3R4LmZpbGxSZWN0KHggLSB0aGlzLl92aWV3cG9ydExvYy54LCB5IC0gdGhpcy5fdmlld3BvcnRMb2MueSwgd2lkdGgsIGhlaWdodCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgY29weUltYWdlOiBmdW5jdGlvbiAob2xkX3gsIG9sZF95LCBuZXdfeCwgbmV3X3ksIHcsIGgsIGZyb21fcXVldWUpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9yZW5kZXJRLmxlbmd0aCAhPT0gMCAmJiAhZnJvbV9xdWV1ZSkge1xuICAgICAgICAgICAgICAgIHRoaXMucmVuZGVyUV9wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgJ3R5cGUnOiAnY29weScsXG4gICAgICAgICAgICAgICAgICAgICdvbGRfeCc6IG9sZF94LFxuICAgICAgICAgICAgICAgICAgICAnb2xkX3knOiBvbGRfeSxcbiAgICAgICAgICAgICAgICAgICAgJ3gnOiBuZXdfeCxcbiAgICAgICAgICAgICAgICAgICAgJ3knOiBuZXdfeSxcbiAgICAgICAgICAgICAgICAgICAgJ3dpZHRoJzogdyxcbiAgICAgICAgICAgICAgICAgICAgJ2hlaWdodCc6IGgsXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHZhciB4MSA9IG9sZF94IC0gdGhpcy5fdmlld3BvcnRMb2MueDtcbiAgICAgICAgICAgICAgICB2YXIgeTEgPSBvbGRfeSAtIHRoaXMuX3ZpZXdwb3J0TG9jLnk7XG4gICAgICAgICAgICAgICAgdmFyIHgyID0gbmV3X3ggLSB0aGlzLl92aWV3cG9ydExvYy54O1xuICAgICAgICAgICAgICAgIHZhciB5MiA9IG5ld195IC0gdGhpcy5fdmlld3BvcnRMb2MueTtcblxuICAgICAgICAgICAgICAgIHRoaXMuX2RyYXdDdHguZHJhd0ltYWdlKHRoaXMuX3RhcmdldCwgeDEsIHkxLCB3LCBoLCB4MiwgeTIsIHcsIGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIC8vIHN0YXJ0IHVwZGF0aW5nIGEgdGlsZVxuICAgICAgICBzdGFydFRpbGU6IGZ1bmN0aW9uICh4LCB5LCB3aWR0aCwgaGVpZ2h0LCBjb2xvcikge1xuICAgICAgICAgICAgdGhpcy5fdGlsZV94ID0geDtcbiAgICAgICAgICAgIHRoaXMuX3RpbGVfeSA9IHk7XG4gICAgICAgICAgICBpZiAod2lkdGggPT09IDE2ICYmIGhlaWdodCA9PT0gMTYpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl90aWxlID0gdGhpcy5fdGlsZTE2eDE2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl90aWxlID0gdGhpcy5fZHJhd0N0eC5jcmVhdGVJbWFnZURhdGEod2lkdGgsIGhlaWdodCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9wcmVmZXJfanMpIHtcbiAgICAgICAgICAgICAgICB2YXIgYmdyO1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl90cnVlX2NvbG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIGJnciA9IGNvbG9yO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGJnciA9IHRoaXMuX2NvbG91ck1hcFtjb2xvclswXV07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHZhciByZWQgPSBiZ3JbMl07XG4gICAgICAgICAgICAgICAgdmFyIGdyZWVuID0gYmdyWzFdO1xuICAgICAgICAgICAgICAgIHZhciBibHVlID0gYmdyWzBdO1xuXG4gICAgICAgICAgICAgICAgdmFyIGRhdGEgPSB0aGlzLl90aWxlLmRhdGE7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCB3aWR0aCAqIGhlaWdodCAqIDQ7IGkgKz0gNCkge1xuICAgICAgICAgICAgICAgICAgICBkYXRhW2ldID0gcmVkO1xuICAgICAgICAgICAgICAgICAgICBkYXRhW2kgKyAxXSA9IGdyZWVuO1xuICAgICAgICAgICAgICAgICAgICBkYXRhW2kgKyAyXSA9IGJsdWU7XG4gICAgICAgICAgICAgICAgICAgIGRhdGFbaSArIDNdID0gMjU1O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5maWxsUmVjdCh4LCB5LCB3aWR0aCwgaGVpZ2h0LCBjb2xvciwgdHJ1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gdXBkYXRlIHN1Yi1yZWN0YW5nbGUgb2YgdGhlIGN1cnJlbnQgdGlsZVxuICAgICAgICBzdWJUaWxlOiBmdW5jdGlvbiAoeCwgeSwgdywgaCwgY29sb3IpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9wcmVmZXJfanMpIHtcbiAgICAgICAgICAgICAgICB2YXIgYmdyO1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLl90cnVlX2NvbG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIGJnciA9IGNvbG9yO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGJnciA9IHRoaXMuX2NvbG91ck1hcFtjb2xvclswXV07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHZhciByZWQgPSBiZ3JbMl07XG4gICAgICAgICAgICAgICAgdmFyIGdyZWVuID0gYmdyWzFdO1xuICAgICAgICAgICAgICAgIHZhciBibHVlID0gYmdyWzBdO1xuICAgICAgICAgICAgICAgIHZhciB4ZW5kID0geCArIHc7XG4gICAgICAgICAgICAgICAgdmFyIHllbmQgPSB5ICsgaDtcblxuICAgICAgICAgICAgICAgIHZhciBkYXRhID0gdGhpcy5fdGlsZS5kYXRhO1xuICAgICAgICAgICAgICAgIHZhciB3aWR0aCA9IHRoaXMuX3RpbGUud2lkdGg7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgaiA9IHk7IGogPCB5ZW5kOyBqKyspIHtcbiAgICAgICAgICAgICAgICAgICAgZm9yICh2YXIgaSA9IHg7IGkgPCB4ZW5kOyBpKyspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHZhciBwID0gKGkgKyAoaiAqIHdpZHRoKSkgKiA0O1xuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YVtwXSA9IHJlZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRhdGFbcCArIDFdID0gZ3JlZW47XG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhW3AgKyAyXSA9IGJsdWU7XG4gICAgICAgICAgICAgICAgICAgICAgICBkYXRhW3AgKyAzXSA9IDI1NTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5maWxsUmVjdCh0aGlzLl90aWxlX3ggKyB4LCB0aGlzLl90aWxlX3kgKyB5LCB3LCBoLCBjb2xvciwgdHJ1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gZHJhdyB0aGUgY3VycmVudCB0aWxlIHRvIHRoZSBzY3JlZW5cbiAgICAgICAgZmluaXNoVGlsZTogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX3ByZWZlcl9qcykge1xuICAgICAgICAgICAgICAgIHRoaXMuX2RyYXdDdHgucHV0SW1hZ2VEYXRhKHRoaXMuX3RpbGUsIHRoaXMuX3RpbGVfeCAtIHRoaXMuX3ZpZXdwb3J0TG9jLngsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdGlsZV95IC0gdGhpcy5fdmlld3BvcnRMb2MueSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBlbHNlOiBOby1vcCAtLSBhbHJlYWR5IGRvbmUgYnkgc2V0U3ViVGlsZVxuICAgICAgICB9LFxuXG4gICAgICAgIGJsaXRJbWFnZTogZnVuY3Rpb24gKHgsIHksIHdpZHRoLCBoZWlnaHQsIGFyciwgb2Zmc2V0LCBmcm9tX3F1ZXVlKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fcmVuZGVyUS5sZW5ndGggIT09IDAgJiYgIWZyb21fcXVldWUpIHtcbiAgICAgICAgICAgICAgICAvLyBOQihkaXJlY3R4bWFuMTIpOiBpdCdzIHRlY2huaWNhbGx5IG1vcmUgcGVyZm9ybWFudCBoZXJlIHRvIHVzZSBwcmVhbGxvY2F0ZWQgYXJyYXlzLFxuICAgICAgICAgICAgICAgIC8vIGJ1dCBpdCdzIGEgbG90IG9mIGV4dHJhIHdvcmsgZm9yIG5vdCBhIGxvdCBvZiBwYXlvZmYgLS0gaWYgd2UncmUgdXNpbmcgdGhlIHJlbmRlciBxdWV1ZSxcbiAgICAgICAgICAgICAgICAvLyB0aGlzIHByb2JhYmx5IGlzbid0IGdldHRpbmcgY2FsbGVkICpuZWFybHkqIGFzIG11Y2hcbiAgICAgICAgICAgICAgICB2YXIgbmV3X2FyciA9IG5ldyBVaW50OEFycmF5KHdpZHRoICogaGVpZ2h0ICogNCk7XG4gICAgICAgICAgICAgICAgbmV3X2Fyci5zZXQobmV3IFVpbnQ4QXJyYXkoYXJyLmJ1ZmZlciwgMCwgbmV3X2Fyci5sZW5ndGgpKTtcbiAgICAgICAgICAgICAgICB0aGlzLnJlbmRlclFfcHVzaCh7XG4gICAgICAgICAgICAgICAgICAgICd0eXBlJzogJ2JsaXQnLFxuICAgICAgICAgICAgICAgICAgICAnZGF0YSc6IG5ld19hcnIsXG4gICAgICAgICAgICAgICAgICAgICd4JzogeCxcbiAgICAgICAgICAgICAgICAgICAgJ3knOiB5LFxuICAgICAgICAgICAgICAgICAgICAnd2lkdGgnOiB3aWR0aCxcbiAgICAgICAgICAgICAgICAgICAgJ2hlaWdodCc6IGhlaWdodCxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy5fdHJ1ZV9jb2xvcikge1xuICAgICAgICAgICAgICAgIHRoaXMuX2JncnhJbWFnZURhdGEoeCwgeSwgdGhpcy5fdmlld3BvcnRMb2MueCwgdGhpcy5fdmlld3BvcnRMb2MueSwgd2lkdGgsIGhlaWdodCwgYXJyLCBvZmZzZXQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9jbWFwSW1hZ2VEYXRhKHgsIHksIHRoaXMuX3ZpZXdwb3J0TG9jLngsIHRoaXMuX3ZpZXdwb3J0TG9jLnksIHdpZHRoLCBoZWlnaHQsIGFyciwgb2Zmc2V0KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBibGl0UmdiSW1hZ2U6IGZ1bmN0aW9uICh4LCB5ICwgd2lkdGgsIGhlaWdodCwgYXJyLCBvZmZzZXQsIGZyb21fcXVldWUpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLl9yZW5kZXJRLmxlbmd0aCAhPT0gMCAmJiAhZnJvbV9xdWV1ZSkge1xuICAgICAgICAgICAgICAgIC8vIE5CKGRpcmVjdHhtYW4xMik6IGl0J3MgdGVjaG5pY2FsbHkgbW9yZSBwZXJmb3JtYW50IGhlcmUgdG8gdXNlIHByZWFsbG9jYXRlZCBhcnJheXMsXG4gICAgICAgICAgICAgICAgLy8gYnV0IGl0J3MgYSBsb3Qgb2YgZXh0cmEgd29yayBmb3Igbm90IGEgbG90IG9mIHBheW9mZiAtLSBpZiB3ZSdyZSB1c2luZyB0aGUgcmVuZGVyIHF1ZXVlLFxuICAgICAgICAgICAgICAgIC8vIHRoaXMgcHJvYmFibHkgaXNuJ3QgZ2V0dGluZyBjYWxsZWQgKm5lYXJseSogYXMgbXVjaFxuICAgICAgICAgICAgICAgIHZhciBuZXdfYXJyID0gbmV3IFVpbnQ4QXJyYXkod2lkdGggKiBoZWlnaHQgKiAzKTtcbiAgICAgICAgICAgICAgICBuZXdfYXJyLnNldChuZXcgVWludDhBcnJheShhcnIuYnVmZmVyLCAwLCBuZXdfYXJyLmxlbmd0aCkpO1xuICAgICAgICAgICAgICAgIHRoaXMucmVuZGVyUV9wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgJ3R5cGUnOiAnYmxpdFJnYicsXG4gICAgICAgICAgICAgICAgICAgICdkYXRhJzogbmV3X2FycixcbiAgICAgICAgICAgICAgICAgICAgJ3gnOiB4LFxuICAgICAgICAgICAgICAgICAgICAneSc6IHksXG4gICAgICAgICAgICAgICAgICAgICd3aWR0aCc6IHdpZHRoLFxuICAgICAgICAgICAgICAgICAgICAnaGVpZ2h0JzogaGVpZ2h0LFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLl90cnVlX2NvbG9yKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fcmdiSW1hZ2VEYXRhKHgsIHksIHRoaXMuX3ZpZXdwb3J0TG9jLngsIHRoaXMuX3ZpZXdwb3J0TG9jLnksIHdpZHRoLCBoZWlnaHQsIGFyciwgb2Zmc2V0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gcHJvYmFibHkgd3Jvbmc/XG4gICAgICAgICAgICAgICAgdGhpcy5fY21hcEltYWdlRGF0YSh4LCB5LCB0aGlzLl92aWV3cG9ydExvYy54LCB0aGlzLl92aWV3cG9ydExvYy55LCB3aWR0aCwgaGVpZ2h0LCBhcnIsIG9mZnNldCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgYmxpdFJnYnhJbWFnZTogZnVuY3Rpb24gKHgsIHksIHdpZHRoLCBoZWlnaHQsIGFyciwgb2Zmc2V0LCBmcm9tX3F1ZXVlKSB7XG4gICAgICAgICAgICBpZiAodGhpcy5fcmVuZGVyUS5sZW5ndGggIT09IDAgJiYgIWZyb21fcXVldWUpIHtcbiAgICAgICAgICAgICAgICAvLyBOQihkaXJlY3R4bWFuMTIpOiBpdCdzIHRlY2huaWNhbGx5IG1vcmUgcGVyZm9ybWFudCBoZXJlIHRvIHVzZSBwcmVhbGxvY2F0ZWQgYXJyYXlzLFxuICAgICAgICAgICAgICAgIC8vIGJ1dCBpdCdzIGEgbG90IG9mIGV4dHJhIHdvcmsgZm9yIG5vdCBhIGxvdCBvZiBwYXlvZmYgLS0gaWYgd2UncmUgdXNpbmcgdGhlIHJlbmRlciBxdWV1ZSxcbiAgICAgICAgICAgICAgICAvLyB0aGlzIHByb2JhYmx5IGlzbid0IGdldHRpbmcgY2FsbGVkICpuZWFybHkqIGFzIG11Y2hcbiAgICAgICAgICAgICAgICB2YXIgbmV3X2FyciA9IG5ldyBVaW50OEFycmF5KHdpZHRoICogaGVpZ2h0ICogNCk7XG4gICAgICAgICAgICAgICAgbmV3X2Fyci5zZXQobmV3IFVpbnQ4QXJyYXkoYXJyLmJ1ZmZlciwgMCwgbmV3X2Fyci5sZW5ndGgpKTtcbiAgICAgICAgICAgICAgICB0aGlzLnJlbmRlclFfcHVzaCh7XG4gICAgICAgICAgICAgICAgICAgICd0eXBlJzogJ2JsaXRSZ2J4JyxcbiAgICAgICAgICAgICAgICAgICAgJ2RhdGEnOiBuZXdfYXJyLFxuICAgICAgICAgICAgICAgICAgICAneCc6IHgsXG4gICAgICAgICAgICAgICAgICAgICd5JzogeSxcbiAgICAgICAgICAgICAgICAgICAgJ3dpZHRoJzogd2lkdGgsXG4gICAgICAgICAgICAgICAgICAgICdoZWlnaHQnOiBoZWlnaHQsXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX3JnYnhJbWFnZURhdGEoeCwgeSwgdGhpcy5fdmlld3BvcnRMb2MueCwgdGhpcy5fdmlld3BvcnRMb2MueSwgd2lkdGgsIGhlaWdodCwgYXJyLCBvZmZzZXQpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIGJsaXRTdHJpbmdJbWFnZTogZnVuY3Rpb24gKHN0ciwgeCwgeSkge1xuICAgICAgICAgICAgdmFyIGltZyA9IG5ldyBJbWFnZSgpO1xuICAgICAgICAgICAgaW1nLm9ubG9hZCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9kcmF3Q3R4LmRyYXdJbWFnZShpbWcsIHggLSB0aGlzLl92aWV3cG9ydExvYy54LCB5IC0gdGhpcy5fdmlld3BvcnRMb2MueSk7XG4gICAgICAgICAgICB9LmJpbmQodGhpcyk7XG4gICAgICAgICAgICBpbWcuc3JjID0gc3RyO1xuICAgICAgICAgICAgcmV0dXJuIGltZzsgLy8gZm9yIGRlYnVnZ2luZyBwdXJwb3Nlc1xuICAgICAgICB9LFxuXG4gICAgICAgIC8vIHdyYXAgY3R4LmRyYXdJbWFnZSBidXQgcmVsYXRpdmUgdG8gdmlld3BvcnRcbiAgICAgICAgZHJhd0ltYWdlOiBmdW5jdGlvbiAoaW1nLCB4LCB5KSB7XG4gICAgICAgICAgICB0aGlzLl9kcmF3Q3R4LmRyYXdJbWFnZShpbWcsIHggLSB0aGlzLl92aWV3cG9ydExvYy54LCB5IC0gdGhpcy5fdmlld3BvcnRMb2MueSk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgcmVuZGVyUV9wdXNoOiBmdW5jdGlvbiAoYWN0aW9uKSB7XG4gICAgICAgICAgICB0aGlzLl9yZW5kZXJRLnB1c2goYWN0aW9uKTtcbiAgICAgICAgICAgIGlmICh0aGlzLl9yZW5kZXJRLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICAgICAgICAgIC8vIElmIHRoaXMgY2FuIGJlIHJlbmRlcmVkIGltbWVkaWF0ZWx5IGl0IHdpbGwgYmUsIG90aGVyd2lzZVxuICAgICAgICAgICAgICAgIC8vIHRoZSBzY2FubmVyIHdpbGwgc3RhcnQgcG9sbGluZyB0aGUgcXVldWUgKGV2ZXJ5XG4gICAgICAgICAgICAgICAgLy8gcmVxdWVzdEFuaW1hdGlvbkZyYW1lIGludGVydmFsKVxuICAgICAgICAgICAgICAgIHRoaXMuX3NjYW5fcmVuZGVyUSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuXG4gICAgICAgIGNoYW5nZUN1cnNvcjogZnVuY3Rpb24gKHBpeGVscywgbWFzaywgaG90eCwgaG90eSwgdywgaCkge1xuICAgICAgICAgICAgaWYgKHRoaXMuX2N1cnNvcl91cmkgPT09IGZhbHNlKSB7XG4gICAgICAgICAgICAgICAgVXRpbC5XYXJuKFwiY2hhbmdlQ3Vyc29yIGNhbGxlZCBidXQgbm8gY3Vyc29yIGRhdGEgVVJJIHN1cHBvcnRcIik7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAodGhpcy5fdHJ1ZV9jb2xvcikge1xuICAgICAgICAgICAgICAgIERpc3BsYXkuY2hhbmdlQ3Vyc29yKHRoaXMuX3RhcmdldCwgcGl4ZWxzLCBtYXNrLCBob3R4LCBob3R5LCB3LCBoKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgRGlzcGxheS5jaGFuZ2VDdXJzb3IodGhpcy5fdGFyZ2V0LCBwaXhlbHMsIG1hc2ssIGhvdHgsIGhvdHksIHcsIGgsIHRoaXMuX2NvbG91ck1hcCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sXG5cbiAgICAgICAgZGVmYXVsdEN1cnNvcjogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdGhpcy5fdGFyZ2V0LnN0eWxlLmN1cnNvciA9IFwiZGVmYXVsdFwiO1xuICAgICAgICB9LFxuXG4gICAgICAgIGRpc2FibGVMb2NhbEN1cnNvcjogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdGhpcy5fdGFyZ2V0LnN0eWxlLmN1cnNvciA9IFwibm9uZVwiO1xuICAgICAgICB9LFxuXG4gICAgICAgIGNsaXBwaW5nRGlzcGxheTogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgdmFyIHZwID0gdGhpcy5fdmlld3BvcnRMb2M7XG5cbiAgICAgICAgICAgIHZhciBmYkNsaXAgPSB0aGlzLl9mYl93aWR0aCA+IHZwLncgfHwgdGhpcy5fZmJfaGVpZ2h0ID4gdnAuaDtcbiAgICAgICAgICAgIHZhciBsaW1pdGVkVnAgPSB0aGlzLl9tYXhXaWR0aCAhPT0gMCAmJiB0aGlzLl9tYXhIZWlnaHQgIT09IDA7XG4gICAgICAgICAgICB2YXIgY2xpcHBpbmcgPSBmYWxzZTtcblxuICAgICAgICAgICAgaWYgKGxpbWl0ZWRWcCkge1xuICAgICAgICAgICAgICAgIGNsaXBwaW5nID0gdnAudyA+IHRoaXMuX21heFdpZHRoIHx8IHZwLmggPiB0aGlzLl9tYXhIZWlnaHQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBmYkNsaXAgfHwgKGxpbWl0ZWRWcCAmJiBjbGlwcGluZyk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgLy8gT3ZlcnJpZGRlbiBnZXR0ZXJzL3NldHRlcnNcbiAgICAgICAgZ2V0X2NvbnRleHQ6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9kcmF3Q3R4O1xuICAgICAgICB9LFxuXG4gICAgICAgIHNldF9zY2FsZTogZnVuY3Rpb24gKHNjYWxlKSB7XG4gICAgICAgICAgICB0aGlzLl9yZXNjYWxlKHNjYWxlKTtcbiAgICAgICAgfSxcblxuICAgICAgICBzZXRfd2lkdGg6IGZ1bmN0aW9uICh3KSB7XG4gICAgICAgICAgICB0aGlzLl9mYl93aWR0aCA9IHc7XG4gICAgICAgIH0sXG4gICAgICAgIGdldF93aWR0aDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZiX3dpZHRoO1xuICAgICAgICB9LFxuXG4gICAgICAgIHNldF9oZWlnaHQ6IGZ1bmN0aW9uIChoKSB7XG4gICAgICAgICAgICB0aGlzLl9mYl9oZWlnaHQgPSAgaDtcbiAgICAgICAgfSxcbiAgICAgICAgZ2V0X2hlaWdodDogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2ZiX2hlaWdodDtcbiAgICAgICAgfSxcblxuICAgICAgICBhdXRvc2NhbGU6IGZ1bmN0aW9uIChjb250YWluZXJXaWR0aCwgY29udGFpbmVySGVpZ2h0LCBkb3duc2NhbGVPbmx5KSB7XG4gICAgICAgICAgICB2YXIgdGFyZ2V0QXNwZWN0UmF0aW8gPSBjb250YWluZXJXaWR0aCAvIGNvbnRhaW5lckhlaWdodDtcbiAgICAgICAgICAgIHZhciBmYkFzcGVjdFJhdGlvID0gdGhpcy5fZmJfd2lkdGggLyB0aGlzLl9mYl9oZWlnaHQ7XG5cbiAgICAgICAgICAgIHZhciBzY2FsZVJhdGlvO1xuICAgICAgICAgICAgaWYgKGZiQXNwZWN0UmF0aW8gPj0gdGFyZ2V0QXNwZWN0UmF0aW8pIHtcbiAgICAgICAgICAgICAgICBzY2FsZVJhdGlvID0gY29udGFpbmVyV2lkdGggLyB0aGlzLl9mYl93aWR0aDtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc2NhbGVSYXRpbyA9IGNvbnRhaW5lckhlaWdodCAvIHRoaXMuX2ZiX2hlaWdodDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdmFyIHRhcmdldFcsIHRhcmdldEg7XG4gICAgICAgICAgICBpZiAoc2NhbGVSYXRpbyA+IDEuMCAmJiBkb3duc2NhbGVPbmx5KSB7XG4gICAgICAgICAgICAgICAgdGFyZ2V0VyA9IHRoaXMuX2ZiX3dpZHRoO1xuICAgICAgICAgICAgICAgIHRhcmdldEggPSB0aGlzLl9mYl9oZWlnaHQ7XG4gICAgICAgICAgICAgICAgc2NhbGVSYXRpbyA9IDEuMDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZmJBc3BlY3RSYXRpbyA+PSB0YXJnZXRBc3BlY3RSYXRpbykge1xuICAgICAgICAgICAgICAgIHRhcmdldFcgPSBjb250YWluZXJXaWR0aDtcbiAgICAgICAgICAgICAgICB0YXJnZXRIID0gTWF0aC5yb3VuZChjb250YWluZXJXaWR0aCAvIGZiQXNwZWN0UmF0aW8pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0YXJnZXRXID0gTWF0aC5yb3VuZChjb250YWluZXJIZWlnaHQgKiBmYkFzcGVjdFJhdGlvKTtcbiAgICAgICAgICAgICAgICB0YXJnZXRIID0gY29udGFpbmVySGVpZ2h0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBOQihkaXJlY3R4bWFuMTIpOiBJZiB5b3Ugc2V0IHRoZSB3aWR0aCBkaXJlY3RseSwgb3Igc2V0IHRoZVxuICAgICAgICAgICAgLy8gICAgICAgICAgICAgICAgICAgc3R5bGUgd2lkdGggdG8gYSBudW1iZXIsIHRoZSBjYW52YXMgaXMgY2xlYXJlZC5cbiAgICAgICAgICAgIC8vICAgICAgICAgICAgICAgICAgIEhvd2V2ZXIsIGlmIHlvdSBzZXQgdGhlIHN0eWxlIHdpZHRoIHRvIGEgc3RyaW5nXG4gICAgICAgICAgICAvLyAgICAgICAgICAgICAgICAgICAoJ05OTnB4JyksIHRoZSBjYW52YXMgaXMgc2NhbGVkIHdpdGhvdXQgY2xlYXJpbmcuXG4gICAgICAgICAgICB0aGlzLl90YXJnZXQuc3R5bGUud2lkdGggPSB0YXJnZXRXICsgJ3B4JztcbiAgICAgICAgICAgIHRoaXMuX3RhcmdldC5zdHlsZS5oZWlnaHQgPSB0YXJnZXRIICsgJ3B4JztcblxuICAgICAgICAgICAgdGhpcy5fc2NhbGUgPSBzY2FsZVJhdGlvO1xuXG4gICAgICAgICAgICByZXR1cm4gc2NhbGVSYXRpbzsgIC8vIHNvIHRoYXQgdGhlIG1vdXNlLCBldGMgc2NhbGUgY2FuIGJlIHNldFxuICAgICAgICB9LFxuXG4gICAgICAgIC8vIFByaXZhdGUgTWV0aG9kc1xuICAgICAgICBfcmVzY2FsZTogZnVuY3Rpb24gKGZhY3Rvcikge1xuICAgICAgICAgICAgdGhpcy5fc2NhbGUgPSBmYWN0b3I7XG5cbiAgICAgICAgICAgIHZhciB3O1xuICAgICAgICAgICAgdmFyIGg7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl92aWV3cG9ydCAmJlxuICAgICAgICAgICAgICAgIHRoaXMuX21heFdpZHRoICE9PSAwICYmIHRoaXMuX21heEhlaWdodCAhPT0gMCkge1xuICAgICAgICAgICAgICAgIHcgPSBNYXRoLm1pbih0aGlzLl9mYl93aWR0aCwgdGhpcy5fbWF4V2lkdGgpO1xuICAgICAgICAgICAgICAgIGggPSBNYXRoLm1pbih0aGlzLl9mYl9oZWlnaHQsIHRoaXMuX21heEhlaWdodCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHcgPSB0aGlzLl9mYl93aWR0aDtcbiAgICAgICAgICAgICAgICBoID0gdGhpcy5fZmJfaGVpZ2h0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aGlzLl90YXJnZXQuc3R5bGUud2lkdGggPSBNYXRoLnJvdW5kKGZhY3RvciAqIHcpICsgJ3B4JztcbiAgICAgICAgICAgIHRoaXMuX3RhcmdldC5zdHlsZS5oZWlnaHQgPSBNYXRoLnJvdW5kKGZhY3RvciAqIGgpICsgJ3B4JztcbiAgICAgICAgfSxcblxuICAgICAgICBfc2V0RmlsbENvbG9yOiBmdW5jdGlvbiAoY29sb3IpIHtcbiAgICAgICAgICAgIHZhciBiZ3I7XG4gICAgICAgICAgICBpZiAodGhpcy5fdHJ1ZV9jb2xvcikge1xuICAgICAgICAgICAgICAgIGJnciA9IGNvbG9yO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBiZ3IgPSB0aGlzLl9jb2xvdXJNYXBbY29sb3JdO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YXIgbmV3U3R5bGUgPSAncmdiKCcgKyBiZ3JbMl0gKyAnLCcgKyBiZ3JbMV0gKyAnLCcgKyBiZ3JbMF0gKyAnKSc7XG4gICAgICAgICAgICBpZiAobmV3U3R5bGUgIT09IHRoaXMuX3ByZXZEcmF3U3R5bGUpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9kcmF3Q3R4LmZpbGxTdHlsZSA9IG5ld1N0eWxlO1xuICAgICAgICAgICAgICAgIHRoaXMuX3ByZXZEcmF3U3R5bGUgPSBuZXdTdHlsZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBfcmdiSW1hZ2VEYXRhOiBmdW5jdGlvbiAoeCwgeSwgdngsIHZ5LCB3aWR0aCwgaGVpZ2h0LCBhcnIsIG9mZnNldCkge1xuICAgICAgICAgICAgdmFyIGltZyA9IHRoaXMuX2RyYXdDdHguY3JlYXRlSW1hZ2VEYXRhKHdpZHRoLCBoZWlnaHQpO1xuICAgICAgICAgICAgdmFyIGRhdGEgPSBpbWcuZGF0YTtcbiAgICAgICAgICAgIGZvciAodmFyIGkgPSAwLCBqID0gb2Zmc2V0OyBpIDwgd2lkdGggKiBoZWlnaHQgKiA0OyBpICs9IDQsIGogKz0gMykge1xuICAgICAgICAgICAgICAgIGRhdGFbaV0gICAgID0gYXJyW2pdO1xuICAgICAgICAgICAgICAgIGRhdGFbaSArIDFdID0gYXJyW2ogKyAxXTtcbiAgICAgICAgICAgICAgICBkYXRhW2kgKyAyXSA9IGFycltqICsgMl07XG4gICAgICAgICAgICAgICAgZGF0YVtpICsgM10gPSAyNTU7ICAvLyBBbHBoYVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5fZHJhd0N0eC5wdXRJbWFnZURhdGEoaW1nLCB4IC0gdngsIHkgLSB2eSk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2JncnhJbWFnZURhdGE6IGZ1bmN0aW9uICh4LCB5LCB2eCwgdnksIHdpZHRoLCBoZWlnaHQsIGFyciwgb2Zmc2V0KSB7XG4gICAgICAgICAgICB2YXIgaW1nID0gdGhpcy5fZHJhd0N0eC5jcmVhdGVJbWFnZURhdGEod2lkdGgsIGhlaWdodCk7XG4gICAgICAgICAgICB2YXIgZGF0YSA9IGltZy5kYXRhO1xuICAgICAgICAgICAgZm9yICh2YXIgaSA9IDAsIGogPSBvZmZzZXQ7IGkgPCB3aWR0aCAqIGhlaWdodCAqIDQ7IGkgKz0gNCwgaiArPSA0KSB7XG4gICAgICAgICAgICAgICAgZGF0YVtpXSAgICAgPSBhcnJbaiArIDJdO1xuICAgICAgICAgICAgICAgIGRhdGFbaSArIDFdID0gYXJyW2ogKyAxXTtcbiAgICAgICAgICAgICAgICBkYXRhW2kgKyAyXSA9IGFycltqXTtcbiAgICAgICAgICAgICAgICBkYXRhW2kgKyAzXSA9IDI1NTsgIC8vIEFscGhhXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aGlzLl9kcmF3Q3R4LnB1dEltYWdlRGF0YShpbWcsIHggLSB2eCwgeSAtIHZ5KTtcbiAgICAgICAgfSxcblxuICAgICAgICBfcmdieEltYWdlRGF0YTogZnVuY3Rpb24gKHgsIHksIHZ4LCB2eSwgd2lkdGgsIGhlaWdodCwgYXJyLCBvZmZzZXQpIHtcbiAgICAgICAgICAgIC8vIE5CKGRpcmVjdHhtYW4xMik6IGFyciBtdXN0IGJlIGFuIFR5cGUgQXJyYXkgdmlld1xuICAgICAgICAgICAgdmFyIGltZztcbiAgICAgICAgICAgIGlmIChTVVBQT1JUU19JTUFHRURBVEFfQ09OU1RSVUNUT1IpIHtcbiAgICAgICAgICAgICAgICBpbWcgPSBuZXcgSW1hZ2VEYXRhKG5ldyBVaW50OENsYW1wZWRBcnJheShhcnIuYnVmZmVyLCBhcnIuYnl0ZU9mZnNldCwgd2lkdGggKiBoZWlnaHQgKiA0KSwgd2lkdGgsIGhlaWdodCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGltZyA9IHRoaXMuX2RyYXdDdHguY3JlYXRlSW1hZ2VEYXRhKHdpZHRoLCBoZWlnaHQpO1xuICAgICAgICAgICAgICAgIGltZy5kYXRhLnNldChuZXcgVWludDhDbGFtcGVkQXJyYXkoYXJyLmJ1ZmZlciwgYXJyLmJ5dGVPZmZzZXQsIHdpZHRoICogaGVpZ2h0ICogNCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5fZHJhd0N0eC5wdXRJbWFnZURhdGEoaW1nLCB4IC0gdngsIHkgLSB2eSk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgX2NtYXBJbWFnZURhdGE6IGZ1bmN0aW9uICh4LCB5LCB2eCwgdnksIHdpZHRoLCBoZWlnaHQsIGFyciwgb2Zmc2V0KSB7XG4gICAgICAgICAgICB2YXIgaW1nID0gdGhpcy5fZHJhd0N0eC5jcmVhdGVJbWFnZURhdGEod2lkdGgsIGhlaWdodCk7XG4gICAgICAgICAgICB2YXIgZGF0YSA9IGltZy5kYXRhO1xuICAgICAgICAgICAgdmFyIGNtYXAgPSB0aGlzLl9jb2xvdXJNYXA7XG4gICAgICAgICAgICBmb3IgKHZhciBpID0gMCwgaiA9IG9mZnNldDsgaSA8IHdpZHRoICogaGVpZ2h0ICogNDsgaSArPSA0LCBqKyspIHtcbiAgICAgICAgICAgICAgICB2YXIgYmdyID0gY21hcFthcnJbal1dO1xuICAgICAgICAgICAgICAgIGRhdGFbaV0gICAgID0gYmdyWzJdO1xuICAgICAgICAgICAgICAgIGRhdGFbaSArIDFdID0gYmdyWzFdO1xuICAgICAgICAgICAgICAgIGRhdGFbaSArIDJdID0gYmdyWzBdO1xuICAgICAgICAgICAgICAgIGRhdGFbaSArIDNdID0gMjU1OyAgLy8gQWxwaGFcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMuX2RyYXdDdHgucHV0SW1hZ2VEYXRhKGltZywgeCAtIHZ4LCB5IC0gdnkpO1xuICAgICAgICB9LFxuXG4gICAgICAgIF9zY2FuX3JlbmRlclE6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHZhciByZWFkeSA9IHRydWU7XG4gICAgICAgICAgICB3aGlsZSAocmVhZHkgJiYgdGhpcy5fcmVuZGVyUS5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgdmFyIGEgPSB0aGlzLl9yZW5kZXJRWzBdO1xuICAgICAgICAgICAgICAgIHN3aXRjaCAoYS50eXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ2NvcHknOlxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5jb3B5SW1hZ2UoYS5vbGRfeCwgYS5vbGRfeSwgYS54LCBhLnksIGEud2lkdGgsIGEuaGVpZ2h0LCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICBjYXNlICdmaWxsJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuZmlsbFJlY3QoYS54LCBhLnksIGEud2lkdGgsIGEuaGVpZ2h0LCBhLmNvbG9yLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICBjYXNlICdibGl0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuYmxpdEltYWdlKGEueCwgYS55LCBhLndpZHRoLCBhLmhlaWdodCwgYS5kYXRhLCAwLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICBjYXNlICdibGl0UmdiJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuYmxpdFJnYkltYWdlKGEueCwgYS55LCBhLndpZHRoLCBhLmhlaWdodCwgYS5kYXRhLCAwLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICBjYXNlICdibGl0UmdieCc6XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmJsaXRSZ2J4SW1hZ2UoYS54LCBhLnksIGEud2lkdGgsIGEuaGVpZ2h0LCBhLmRhdGEsIDAsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ2ltZyc6XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYS5pbWcuY29tcGxldGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmRyYXdJbWFnZShhLmltZywgYS54LCBhLnkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBXZSBuZWVkIHRvIHdhaXQgZm9yIHRoaXMgaW1hZ2UgdG8gJ2xvYWQnXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gdG8ga2VlcCB0aGluZ3MgaW4tb3JkZXJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWFkeSA9IGZhbHNlO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHJlYWR5KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3JlbmRlclEuc2hpZnQoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0aGlzLl9yZW5kZXJRLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUodGhpcy5fc2Nhbl9yZW5kZXJRLmJpbmQodGhpcykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LFxuICAgIH07XG5cbiAgICBVdGlsLm1ha2VfcHJvcGVydGllcyhEaXNwbGF5LCBbXG4gICAgICAgIFsndGFyZ2V0JywgJ3dvJywgJ2RvbSddLCAgICAgICAvLyBDYW52YXMgZWxlbWVudCBmb3IgcmVuZGVyaW5nXG4gICAgICAgIFsnY29udGV4dCcsICdybycsICdyYXcnXSwgICAgICAvLyBDYW52YXMgMkQgY29udGV4dCBmb3IgcmVuZGVyaW5nIChyZWFkLW9ubHkpXG4gICAgICAgIFsnbG9nbycsICdydycsICdyYXcnXSwgICAgICAgICAvLyBMb2dvIHRvIGRpc3BsYXkgd2hlbiBjbGVhcmVkOiB7XCJ3aWR0aFwiOiB3LCBcImhlaWdodFwiOiBoLCBcImRhdGFcIjogZGF0YX1cbiAgICAgICAgWyd0cnVlX2NvbG9yJywgJ3J3JywgJ2Jvb2wnXSwgIC8vIFVzZSB0cnVlLWNvbG9yIHBpeGVsIGRhdGFcbiAgICAgICAgWydjb2xvdXJNYXAnLCAncncnLCAnYXJyJ10sICAgIC8vIENvbG91ciBtYXAgYXJyYXkgKHdoZW4gbm90IHRydWUtY29sb3IpXG4gICAgICAgIFsnc2NhbGUnLCAncncnLCAnZmxvYXQnXSwgICAgICAvLyBEaXNwbGF5IGFyZWEgc2NhbGUgZmFjdG9yIDAuMCAtIDEuMFxuICAgICAgICBbJ3ZpZXdwb3J0JywgJ3J3JywgJ2Jvb2wnXSwgICAgLy8gVXNlIHZpZXdwb3J0IGNsaXBwaW5nXG4gICAgICAgIFsnd2lkdGgnLCAncncnLCAnaW50J10sICAgICAgICAvLyBEaXNwbGF5IGFyZWEgd2lkdGhcbiAgICAgICAgWydoZWlnaHQnLCAncncnLCAnaW50J10sICAgICAgIC8vIERpc3BsYXkgYXJlYSBoZWlnaHRcbiAgICAgICAgWydtYXhXaWR0aCcsICdydycsICdpbnQnXSwgICAgIC8vIFZpZXdwb3J0IG1heCB3aWR0aCAoMCBpZiBkaXNhYmxlZClcbiAgICAgICAgWydtYXhIZWlnaHQnLCAncncnLCAnaW50J10sICAgIC8vIFZpZXdwb3J0IG1heCBoZWlnaHQgKDAgaWYgZGlzYWJsZWQpXG5cbiAgICAgICAgWydyZW5kZXJfbW9kZScsICdybycsICdzdHInXSwgIC8vIENhbnZhcyByZW5kZXJpbmcgbW9kZSAocmVhZC1vbmx5KVxuXG4gICAgICAgIFsncHJlZmVyX2pzJywgJ3J3JywgJ3N0ciddLCAgICAvLyBQcmVmZXIgSmF2YXNjcmlwdCBvdmVyIGNhbnZhcyBtZXRob2RzXG4gICAgICAgIFsnY3Vyc29yX3VyaScsICdydycsICdyYXcnXSAgICAvLyBDYW4gd2UgcmVuZGVyIGN1cnNvciB1c2luZyBkYXRhIFVSSVxuICAgIF0pO1xuXG4gICAgLy8gQ2xhc3MgTWV0aG9kc1xuICAgIERpc3BsYXkuY2hhbmdlQ3Vyc29yID0gZnVuY3Rpb24gKHRhcmdldCwgcGl4ZWxzLCBtYXNrLCBob3R4LCBob3R5LCB3MCwgaDAsIGNtYXApIHtcbiAgICAgICAgdmFyIHcgPSB3MDtcbiAgICAgICAgdmFyIGggPSBoMDtcbiAgICAgICAgaWYgKGggPCB3KSB7XG4gICAgICAgICAgICBoID0gdzsgIC8vIGluY3JlYXNlIGggdG8gbWFrZSBpdCBzcXVhcmVcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHcgPSBoOyAgLy8gaW5jcmVhc2UgdyB0byBtYWtlIGl0IHNxdWFyZVxuICAgICAgICB9XG5cbiAgICAgICAgdmFyIGN1ciA9IFtdO1xuXG4gICAgICAgIC8vIFB1c2ggbXVsdGktYnl0ZSBsaXR0bGUtZW5kaWFuIHZhbHVlc1xuICAgICAgICBjdXIucHVzaDE2bGUgPSBmdW5jdGlvbiAobnVtKSB7XG4gICAgICAgICAgICB0aGlzLnB1c2gobnVtICYgMHhGRiwgKG51bSA+PiA4KSAmIDB4RkYpO1xuICAgICAgICB9O1xuICAgICAgICBjdXIucHVzaDMybGUgPSBmdW5jdGlvbiAobnVtKSB7XG4gICAgICAgICAgICB0aGlzLnB1c2gobnVtICYgMHhGRixcbiAgICAgICAgICAgICAgICAgICAgICAobnVtID4+IDgpICYgMHhGRixcbiAgICAgICAgICAgICAgICAgICAgICAobnVtID4+IDE2KSAmIDB4RkYsXG4gICAgICAgICAgICAgICAgICAgICAgKG51bSA+PiAyNCkgJiAweEZGKTtcbiAgICAgICAgfTtcblxuICAgICAgICB2YXIgSUhEUnN6ID0gNDA7XG4gICAgICAgIHZhciBSR0JzeiA9IHcgKiBoICogNDtcbiAgICAgICAgdmFyIFhPUnN6ID0gTWF0aC5jZWlsKCh3ICogaCkgLyA4LjApO1xuICAgICAgICB2YXIgQU5Ec3ogPSBNYXRoLmNlaWwoKHcgKiBoKSAvIDguMCk7XG5cbiAgICAgICAgY3VyLnB1c2gxNmxlKDApOyAgICAgICAgLy8gMDogUmVzZXJ2ZWRcbiAgICAgICAgY3VyLnB1c2gxNmxlKDIpOyAgICAgICAgLy8gMjogLkNVUiB0eXBlXG4gICAgICAgIGN1ci5wdXNoMTZsZSgxKTsgICAgICAgIC8vIDQ6IE51bWJlciBvZiBpbWFnZXMsIDEgZm9yIG5vbi1hbmltYXRlZCBpY29cblxuICAgICAgICAvLyBDdXJzb3IgIzEgaGVhZGVyIChJQ09ORElSRU5UUlkpXG4gICAgICAgIGN1ci5wdXNoKHcpOyAgICAgICAgICAgIC8vIDY6IHdpZHRoXG4gICAgICAgIGN1ci5wdXNoKGgpOyAgICAgICAgICAgIC8vIDc6IGhlaWdodFxuICAgICAgICBjdXIucHVzaCgwKTsgICAgICAgICAgICAvLyA4OiBjb2xvcnMsIDAgLT4gdHJ1ZS1jb2xvclxuICAgICAgICBjdXIucHVzaCgwKTsgICAgICAgICAgICAvLyA5OiByZXNlcnZlZFxuICAgICAgICBjdXIucHVzaDE2bGUoaG90eCk7ICAgICAvLyAxMDogaG90c3BvdCB4IGNvb3JkaW5hdGVcbiAgICAgICAgY3VyLnB1c2gxNmxlKGhvdHkpOyAgICAgLy8gMTI6IGhvdHNwb3QgeSBjb29yZGluYXRlXG4gICAgICAgIGN1ci5wdXNoMzJsZShJSERSc3ogKyBSR0JzeiArIFhPUnN6ICsgQU5Ec3opO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyAxNDogY3Vyc29yIGRhdGEgYnl0ZSBzaXplXG4gICAgICAgIGN1ci5wdXNoMzJsZSgyMik7ICAgICAgIC8vIDE4OiBvZmZzZXQgb2YgY3Vyc29yIGRhdGEgaW4gdGhlIGZpbGVcblxuICAgICAgICAvLyBDdXJzb3IgIzEgSW5mb0hlYWRlciAoSUNPTklNQUdFL0JJVE1BUElORk8pXG4gICAgICAgIGN1ci5wdXNoMzJsZShJSERSc3opOyAgIC8vIDIyOiBJbmZvSGVhZGVyIHNpemVcbiAgICAgICAgY3VyLnB1c2gzMmxlKHcpOyAgICAgICAgLy8gMjY6IEN1cnNvciB3aWR0aFxuICAgICAgICBjdXIucHVzaDMybGUoaCAqIDIpOyAgICAvLyAzMDogWE9SK0FORCBoZWlnaHRcbiAgICAgICAgY3VyLnB1c2gxNmxlKDEpOyAgICAgICAgLy8gMzQ6IG51bWJlciBvZiBwbGFuZXNcbiAgICAgICAgY3VyLnB1c2gxNmxlKDMyKTsgICAgICAgLy8gMzY6IGJpdHMgcGVyIHBpeGVsXG4gICAgICAgIGN1ci5wdXNoMzJsZSgwKTsgICAgICAgIC8vIDM4OiBUeXBlIG9mIGNvbXByZXNzaW9uXG5cbiAgICAgICAgY3VyLnB1c2gzMmxlKFhPUnN6ICsgQU5Ec3opO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyA0MjogU2l6ZSBvZiBJbWFnZVxuICAgICAgICBjdXIucHVzaDMybGUoMCk7ICAgICAgICAvLyA0NjogcmVzZXJ2ZWRcbiAgICAgICAgY3VyLnB1c2gzMmxlKDApOyAgICAgICAgLy8gNTA6IHJlc2VydmVkXG4gICAgICAgIGN1ci5wdXNoMzJsZSgwKTsgICAgICAgIC8vIDU0OiByZXNlcnZlZFxuICAgICAgICBjdXIucHVzaDMybGUoMCk7ICAgICAgICAvLyA1ODogcmVzZXJ2ZWRcblxuICAgICAgICAvLyA2MjogY29sb3IgZGF0YSAoUkdCUVVBRCBpY0NvbG9yc1tdKVxuICAgICAgICB2YXIgeSwgeDtcbiAgICAgICAgZm9yICh5ID0gaCAtIDE7IHkgPj0gMDsgeS0tKSB7XG4gICAgICAgICAgICBmb3IgKHggPSAwOyB4IDwgdzsgeCsrKSB7XG4gICAgICAgICAgICAgICAgaWYgKHggPj0gdzAgfHwgeSA+PSBoMCkge1xuICAgICAgICAgICAgICAgICAgICBjdXIucHVzaCgwKTsgIC8vIGJsdWVcbiAgICAgICAgICAgICAgICAgICAgY3VyLnB1c2goMCk7ICAvLyBncmVlblxuICAgICAgICAgICAgICAgICAgICBjdXIucHVzaCgwKTsgIC8vIHJlZFxuICAgICAgICAgICAgICAgICAgICBjdXIucHVzaCgwKTsgIC8vIGFscGhhXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGlkeCA9IHkgKiBNYXRoLmNlaWwodzAgLyA4KSArIE1hdGguZmxvb3IoeCAvIDgpO1xuICAgICAgICAgICAgICAgICAgICB2YXIgYWxwaGEgPSAobWFza1tpZHhdIDw8ICh4ICUgOCkpICYgMHg4MCA/IDI1NSA6IDA7XG4gICAgICAgICAgICAgICAgICAgIGlmIChjbWFwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZHggPSAodzAgKiB5KSArIHg7XG4gICAgICAgICAgICAgICAgICAgICAgICB2YXIgcmdiID0gY21hcFtwaXhlbHNbaWR4XV07XG4gICAgICAgICAgICAgICAgICAgICAgICBjdXIucHVzaChyZ2JbMl0pOyAgLy8gYmx1ZVxuICAgICAgICAgICAgICAgICAgICAgICAgY3VyLnB1c2gocmdiWzFdKTsgIC8vIGdyZWVuXG4gICAgICAgICAgICAgICAgICAgICAgICBjdXIucHVzaChyZ2JbMF0pOyAgLy8gcmVkXG4gICAgICAgICAgICAgICAgICAgICAgICBjdXIucHVzaChhbHBoYSk7ICAgLy8gYWxwaGFcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlkeCA9ICgodzAgKiB5KSArIHgpICogNDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGN1ci5wdXNoKHBpeGVsc1tpZHggKyAyXSk7IC8vIGJsdWVcbiAgICAgICAgICAgICAgICAgICAgICAgIGN1ci5wdXNoKHBpeGVsc1tpZHggKyAxXSk7IC8vIGdyZWVuXG4gICAgICAgICAgICAgICAgICAgICAgICBjdXIucHVzaChwaXhlbHNbaWR4XSk7ICAgICAvLyByZWRcbiAgICAgICAgICAgICAgICAgICAgICAgIGN1ci5wdXNoKGFscGhhKTsgICAgICAgICAgIC8vIGFscGhhXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBYT1IvYml0bWFzayBkYXRhIChCWVRFIGljWE9SW10pXG4gICAgICAgIC8vIChpZ25vcmVkLCBqdXN0IG5lZWRzIHRvIGJlIHRoZSByaWdodCBzaXplKVxuICAgICAgICBmb3IgKHkgPSAwOyB5IDwgaDsgeSsrKSB7XG4gICAgICAgICAgICBmb3IgKHggPSAwOyB4IDwgTWF0aC5jZWlsKHcgLyA4KTsgeCsrKSB7XG4gICAgICAgICAgICAgICAgY3VyLnB1c2goMCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBBTkQvYml0bWFzayBkYXRhIChCWVRFIGljQU5EW10pXG4gICAgICAgIC8vIChpZ25vcmVkLCBqdXN0IG5lZWRzIHRvIGJlIHRoZSByaWdodCBzaXplKVxuICAgICAgICBmb3IgKHkgPSAwOyB5IDwgaDsgeSsrKSB7XG4gICAgICAgICAgICBmb3IgKHggPSAwOyB4IDwgTWF0aC5jZWlsKHcgLyA4KTsgeCsrKSB7XG4gICAgICAgICAgICAgICAgY3VyLnB1c2goMCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB2YXIgdXJsID0gJ2RhdGE6aW1hZ2UveC1pY29uO2Jhc2U2NCwnICsgQmFzZTY0LmVuY29kZShjdXIpO1xuICAgICAgICB0YXJnZXQuc3R5bGUuY3Vyc29yID0gJ3VybCgnICsgdXJsICsgJyknICsgaG90eCArICcgJyArIGhvdHkgKyAnLCBkZWZhdWx0JztcbiAgICB9O1xufSkoKTtcbiJdfQ==