            // ============================================================
            // SunoForge i18n Engine v1
            // Translations loaded from lang/{locale}.json via fetch().
            // English text stays embedded in the HTML as the baseline.
            // NOTE: fetch() of local files is blocked on the file:// protocol
            // in Chromium browsers — serve via a local HTTP server (e.g. VS
            // Code Live Server) to enable non-English locales.
            // ============================================================
            window.I18N = (() => {
                let _data = {};
                let _locale = "en";
                const t = (key, fallback) => (_data[key] !== undefined ? _data[key] : fallback !== undefined ? fallback : key);
                const fmt = (key, fallback, ...args) => {
                    let s = t(key, fallback);
                    args.forEach((a, i) => {
                        s = s.replace(new RegExp(`\\{${i}\\}`, "g"), a);
                    });
                    return s;
                };
                const apply = () => {
                    document.querySelectorAll("[data-i18n]").forEach((el) => {
                        const v = t(el.dataset.i18n);
                        if (v !== el.dataset.i18n) el.innerHTML = v;
                    });
                    document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
                        const v = t(el.dataset.i18nPh);
                        if (v !== el.dataset.i18nPh) el.placeholder = v;
                    });
                    document.querySelectorAll("[data-i18n-opt]").forEach((el) => {
                        const v = t(el.dataset.i18nOpt);
                        if (v !== el.dataset.i18nOpt) el.textContent = v;
                    });
                    const s = document.getElementById("lang-select");
                    if (s) s.value = _locale;
                };
                const switchLocale = async (locale) => {
                    _data = {};
                    _locale = locale;
                    if (locale !== "en") {
                        try {
                            const r = await fetch("lang/" + locale + ".json");
                            if (!r.ok) throw new Error("HTTP " + r.status);
                            _data = await r.json();
                        } catch (e) {
                            console.warn(`[i18n] Cannot load "lang/${locale}.json": ${e.message}`);
                            _data = {};
                            _locale = "en";
                        }
                    }
                    // Restore English originals, then overlay translations
                    document.querySelectorAll("[data-i18n]").forEach((el) => {
                        if (el.dataset.i18nEn !== undefined) el.innerHTML = el.dataset.i18nEn;
                    });
                    document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
                        if (el.dataset.i18nPhEn !== undefined) el.placeholder = el.dataset.i18nPhEn;
                    });
                    document.querySelectorAll("[data-i18n-opt]").forEach((el) => {
                        if (el.dataset.i18nOptEn !== undefined) el.textContent = el.dataset.i18nOptEn;
                    });
                    apply();
                    localStorage.setItem("sf_locale", _locale);
                };
                const init = async () => {
                    // Snapshot live English content as fallback before any translation runs
                    document.querySelectorAll("[data-i18n]").forEach((el) => {
                        el.dataset.i18nEn = el.innerHTML;
                    });
                    document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
                        el.dataset.i18nPhEn = el.placeholder;
                    });
                    document.querySelectorAll("[data-i18n-opt]").forEach((el) => {
                        el.dataset.i18nOptEn = el.textContent;
                    });
                    const saved = localStorage.getItem("sf_locale") || "en";
                    if (saved !== "en") await switchLocale(saved);
                    const s = document.getElementById("lang-select");
                    if (s) s.value = _locale;
                };
                return { t, fmt, apply, switchLocale, init };
            })();
