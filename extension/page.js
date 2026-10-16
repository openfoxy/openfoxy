// Runs in the page's MAIN world (declared in the manifest). The User-Agent is resolved by
// content.js and arrives in the event detail, so this file has no preset table of its own.
(function () {
  const EVENT_NAME = "openfoxy:apply-profile";
  const applied = new Set();
  const original = { random: Math.random, matchMedia: window.matchMedia?.bind(window) };

  function define(target, key, value) {
    try {
      Object.defineProperty(target, key, { configurable: true, get: () => value });
    } catch {
      // Non-configurable properties cannot be redefined; skip them.
    }
  }

  function method(target, key, fn) {
    try {
      Object.defineProperty(target, key, { configurable: true, writable: true, value: fn });
    } catch {
      // Non-configurable properties cannot be redefined; skip them.
    }
  }

  function languageList(language) {
    const primary =
      String(language || "en-US")
        .split(",")[0]
        .trim() || "en-US";
    const base = primary.split("-")[0];
    return primary === base ? [primary] : [primary, base];
  }

  function timezoneFor(profile) {
    if (profile.timezone === "system") return null;
    const language = String(profile.language || "").toLowerCase();
    if (language.startsWith("fr")) return "Europe/Paris";
    if (language.startsWith("de")) return "Europe/Berlin";
    if (language.startsWith("es")) return "Europe/Madrid";
    if (language.startsWith("ja")) return "Asia/Tokyo";
    if (language.startsWith("zh")) return "Asia/Shanghai";
    if (language.startsWith("en-gb")) return "Europe/London";
    return "America/New_York";
  }

  function parseResolution(value) {
    const match = String(value || "1920x1080").match(/^(\d{2,5})\s*x\s*(\d{2,5})$/i);
    return match
      ? { width: Number(match[1]), height: Number(match[2]) }
      : { width: 1920, height: 1080 };
  }

  function spoofNavigator(profile, settings, userAgent) {
    const languages = languageList(profile.language);
    if (userAgent) define(Navigator.prototype, "userAgent", userAgent);
    define(Navigator.prototype, "platform", profile.platform || "Win32");
    define(Navigator.prototype, "language", languages[0]);
    define(Navigator.prototype, "languages", Object.freeze(languages));
    if (settings.cpuSpoof)
      define(Navigator.prototype, "hardwareConcurrency", Number(profile.hardware) || 8);
    if (settings.memorySpoof)
      define(Navigator.prototype, "deviceMemory", Number(profile.memory) || 8);
    if (settings.touchPoints)
      define(Navigator.prototype, "maxTouchPoints", Number(profile.touch) || 0);
    if (settings.dnt) define(Navigator.prototype, "doNotTrack", "1");
    if (settings.gpc) define(Navigator.prototype, "globalPrivacyControl", true);
    if (settings.plugins) {
      define(Navigator.prototype, "plugins", Object.freeze([]));
      define(Navigator.prototype, "mimeTypes", Object.freeze([]));
    }
  }

  function spoofScreen(profile, settings) {
    const res = parseResolution(profile.resolution);
    if (settings.screenRes) {
      define(Screen.prototype, "width", res.width);
      define(Screen.prototype, "height", res.height);
      define(Screen.prototype, "availWidth", res.width);
      define(Screen.prototype, "availHeight", Math.max(res.height - 40, 1));
    }
    if (settings.colorDepth) {
      const depth = Number(profile.colorDepth) || 24;
      define(Screen.prototype, "colorDepth", depth);
      define(Screen.prototype, "pixelDepth", depth);
    }
    if (settings.pixelRatio) define(window, "devicePixelRatio", Number(profile.pixelRatio) || 1);
  }

  function spoofIntl(profile) {
    const timeZone = timezoneFor(profile);
    if (!timeZone || applied.has("intl")) return;
    applied.add("intl");
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function (locale, options) {
      const formatter = new NativeDateTimeFormat(locale || profile.language || undefined, {
        ...(options || {}),
        timeZone: options?.timeZone || timeZone,
      });
      const nativeResolved = formatter.resolvedOptions.bind(formatter);
      formatter.resolvedOptions = () => ({ ...nativeResolved(), timeZone });
      return formatter;
    };
    Intl.DateTimeFormat.prototype = NativeDateTimeFormat.prototype;
  }

  function spoofCanvas(settings) {
    if (!settings.canvasNoise || applied.has("canvas")) return;
    applied.add("canvas");
    const noise = (canvas) => {
      try {
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        const data = ctx.getImageData(
          0,
          0,
          Math.min(canvas.width, 32),
          Math.min(canvas.height, 32),
        );
        for (let i = 0; i < data.data.length; i += 32) data.data[i] = data.data[i] ^ 1;
        ctx.putImageData(data, 0, 0);
      } catch {
        // Tainted or zero-sized canvases cannot be read; leave them untouched.
      }
    };
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    method(HTMLCanvasElement.prototype, "toDataURL", function (...args) {
      noise(this);
      return toDataURL.apply(this, args);
    });
    method(HTMLCanvasElement.prototype, "toBlob", function (...args) {
      noise(this);
      return toBlob.apply(this, args);
    });
    const getImageData = CanvasRenderingContext2D.prototype.getImageData;
    method(CanvasRenderingContext2D.prototype, "getImageData", function (...args) {
      const image = getImageData.apply(this, args);
      for (let i = 0; i < image.data.length; i += 64) image.data[i] = image.data[i] ^ 1;
      return image;
    });
  }

  function spoofWebGL(settings) {
    if (!settings.webglSpoof || applied.has("webgl")) return;
    applied.add("webgl");
    const patch = (proto) => {
      if (!proto?.getParameter) return;
      const getParameter = proto.getParameter;
      method(proto, "getParameter", function (param) {
        if (param === 37445) return "Google Inc.";
        if (param === 37446) return "ANGLE (Intel, Intel UHD Graphics)";
        return getParameter.call(this, param);
      });
    };
    patch(typeof WebGLRenderingContext !== "undefined" ? WebGLRenderingContext.prototype : null);
    patch(typeof WebGL2RenderingContext !== "undefined" ? WebGL2RenderingContext.prototype : null);
  }

  function spoofAudio(settings) {
    if (!settings.audioNoise || applied.has("audio") || typeof AudioBuffer === "undefined") return;
    applied.add("audio");
    const getChannelData = AudioBuffer.prototype.getChannelData;
    method(AudioBuffer.prototype, "getChannelData", function (...args) {
      const data = getChannelData.apply(this, args);
      for (let i = 0; i < data.length; i += 100) data[i] += 0.0000001;
      return data;
    });
  }

  function fontFamilyList(font) {
    return String(font || "")
      .split(",")
      .map((family) => family.replace(/["']/g, "").trim().toLowerCase())
      .filter(Boolean);
  }

  function commonFontSet(profile) {
    const shared = [
      "arial",
      "courier new",
      "georgia",
      "times new roman",
      "trebuchet ms",
      "verdana",
      "serif",
      "sans-serif",
      "monospace",
      "cursive",
      "fantasy",
      "system-ui",
      "emoji",
      "math",
      "fangsong",
    ];
    const platform = String(profile.platform || "").toLowerCase();
    const platformFonts = platform.includes("mac")
      ? ["helvetica", "helvetica neue", "menlo", "monaco", "apple color emoji"]
      : platform.includes("linux")
        ? ["noto sans", "noto serif", "noto color emoji", "liberation sans", "liberation serif"]
        : ["segoe ui", "consolas", "calibri", "cambria", "tahoma", "microsoft sans serif"];
    return new Set([...shared, ...platformFonts]);
  }

  function fontIsAllowed(font, allowedFonts) {
    const families = fontFamilyList(font);
    return families.length === 0 || families.some((family) => allowedFonts.has(family));
  }

  function spoofFonts(profile, settings) {
    if (!settings.fontMask || applied.has("fonts")) return;
    applied.add("fonts");
    const allowedFonts = commonFontSet(profile);

    if (typeof CanvasRenderingContext2D !== "undefined") {
      const measureText = CanvasRenderingContext2D.prototype.measureText;
      method(CanvasRenderingContext2D.prototype, "measureText", function (...args) {
        const originalFont = this.font;
        if (!fontIsAllowed(originalFont, allowedFonts)) this.font = "16px Arial, sans-serif";
        try {
          return measureText.apply(this, args);
        } finally {
          if (this.font !== originalFont) this.font = originalFont;
        }
      });
    }

    if (typeof FontFaceSet !== "undefined" && document.fonts) {
      const check = FontFaceSet.prototype.check;
      method(FontFaceSet.prototype, "check", function (font, text) {
        if (!fontIsAllowed(font, allowedFonts)) return false;
        return check.call(this, font, text);
      });
    }
  }

  function spoofHardwareApis(profile, settings) {
    if (settings.batteryMask && navigator.getBattery) {
      method(Navigator.prototype, "getBattery", () =>
        Promise.resolve({
          charging: true,
          chargingTime: 0,
          dischargingTime: Infinity,
          level: 1,
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() {
            return true;
          },
        }),
      );
    }
    if (settings.netInfo && navigator.connection) {
      const proto = Object.getPrototypeOf(navigator.connection);
      define(proto, "effectiveType", profile.network || "4g");
      define(proto, "downlink", profile.network === "wifi" ? 10 : 3);
      define(proto, "rtt", profile.network === "wifi" ? 30 : 90);
    }
  }

  function spoofPermissions(settings) {
    const denied = (message) => Promise.reject(new DOMException(message, "NotAllowedError"));
    if (settings.permGeo && navigator.geolocation && typeof Geolocation !== "undefined") {
      method(Geolocation.prototype, "getCurrentPosition", function (success, error) {
        if (error) error({ code: 1, message: "Blocked by OpenFoxy" });
      });
      method(Geolocation.prototype, "watchPosition", function (success, error) {
        if (error) error({ code: 1, message: "Blocked by OpenFoxy" });
        return 0;
      });
    }
    if (navigator.mediaDevices && typeof MediaDevices !== "undefined") {
      const nativeGetUserMedia = navigator.mediaDevices.getUserMedia?.bind(navigator.mediaDevices);
      method(MediaDevices.prototype, "getUserMedia", function (constraints) {
        if ((settings.permCam && constraints?.video) || (settings.permMic && constraints?.audio))
          return denied("Blocked by OpenFoxy");
        return nativeGetUserMedia ? nativeGetUserMedia(constraints) : denied("Unavailable");
      });
      if (settings.permDevices)
        method(MediaDevices.prototype, "enumerateDevices", () => Promise.resolve([]));
    }
    if (settings.permClip && navigator.clipboard?.readText && typeof Clipboard !== "undefined") {
      method(Clipboard.prototype, "readText", () => denied("Blocked by OpenFoxy"));
      method(Clipboard.prototype, "read", () => denied("Blocked by OpenFoxy"));
    }
  }

  function spoofMisc(settings) {
    if (settings.mathJitter && !applied.has("math")) {
      applied.add("math");
      method(Math, "random", () => Math.min(original.random() + 0.000000001, 0.999999999));
    }
    if (settings.prefersScheme && original.matchMedia) {
      method(window, "matchMedia", function (query) {
        const result = original.matchMedia(query);
        if (/prefers-color-scheme/i.test(query))
          define(result, "matches", /dark/i.test(query) === (settings.theme === "dark"));
        return result;
      });
    }
  }

  function apply(config) {
    if (!config?.profile) return;
    const { profile, settings, userAgent } = config;
    spoofNavigator(profile, settings, userAgent);
    spoofScreen(profile, settings);
    spoofIntl(profile);
    spoofCanvas(settings);
    spoofWebGL(settings);
    spoofAudio(settings);
    spoofFonts(profile, settings);
    spoofHardwareApis(profile, settings);
    spoofPermissions(settings);
    spoofMisc(settings);
  }

  window.addEventListener(EVENT_NAME, (event) => {
    if (typeof event.detail !== "string") return;
    try {
      apply(JSON.parse(event.detail));
    } catch {
      // Ignore events that were not produced by content.js.
    }
  });
})();
