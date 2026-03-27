            import { GoogleGenAI } from "@google/genai";

            let aiClient = null;
            let activeApiProvider = localStorage.getItem("active_api_provider") || "google"; // "google" | "openrouter" | "custom"
            let selectedModel = localStorage.getItem("selected_model") || "gemini-3.1-flash-lite-preview";
            let modelChangedLocally = false; // set when user picks a model; cleared after Drive write so Drive can't clobber the fresh choice
            let modelProviderMap = {}; // maps model ID → "google" | "openrouter" | "custom"
            let googleModels = []; // cached list from last successful Google fetch
            let openrouterModels = []; // cached list from last successful OpenRouter fetch
            let customServerAddress = localStorage.getItem("custom_server_address") || "";
            let customModels = JSON.parse(localStorage.getItem("custom_models") || "[]"); // manually-added model IDs
            let customServerModels = []; // fetched from /v1/models on the custom server (ephemeral)
            const STORAGE_PROVIDER_KEY = "sf_storage_provider";
            const STORAGE_PROVIDER_LOCAL = "local";
            const STORAGE_PROVIDER_DRIVE = "drive";
            // Google OAuth client ID (public — security relies on authorized origins, not this value)
            const DRIVE_CLIENT_ID = ["480861081290-pdu3ielsecd27iliiafl6kqbb3tp17qc", "apps.googleusercontent.com"].join(".");
            const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
            const DRIVE_HISTORY_FILE = "sunoforge-history.json";
            const DRIVE_SETTINGS_FILE = "sunoforge-settings.json";
            const DRIVE_PRESETS_FILE = "sunoforge-presets.json";
            const PRESETS_STORAGE_KEY = "sf_presets";
            const DRIVE_SESSION_TOKEN_KEY = "sf_drive_session";
            const SONG_HISTORY_STORAGE_KEY = "sunoforge_history";

            let storageProvider = localStorage.getItem(STORAGE_PROVIDER_KEY) || STORAGE_PROVIDER_LOCAL;
            const driveClientId = DRIVE_CLIENT_ID;
            let driveAccessToken = null;
            let driveTokenExpiresAt = 0;

            // Restore token from sessionStorage so page reload doesn't force a new OAuth popup
            (function () {
                try {
                    const saved = JSON.parse(sessionStorage.getItem(DRIVE_SESSION_TOKEN_KEY) || "null");
                    if (saved && saved.token && saved.expiresAt && Date.now() < saved.expiresAt - 60000) {
                        driveAccessToken = saved.token;
                        driveTokenExpiresAt = saved.expiresAt;
                    }
                } catch (_) {}
            })();
            let driveTokenClient = null;
            let driveSyncTimer = null;
            let driveSyncInFlight = null;
            let lastDriveSyncAt = null;
            let songPresets = [];

            // i18n shorthand helpers — delegate through the global engine
            const _t = (k, fb) => window.I18N.t(k, fb);
            const _fmt = (k, fb, ...a) => window.I18N.fmt(k, fb, ...a);

            function getStoredSetting(key, fallback = "") {
                const value = localStorage.getItem(key);
                return value === null ? fallback : value;
            }

            function setStoredSetting(key, value) {
                if (value === null || value === undefined || value === "") {
                    localStorage.removeItem(key);
                    return;
                }
                localStorage.setItem(key, String(value));
            }

            function buildSyncedSettingsPayload() {
                return {
                    version: 1,
                    savedAt: new Date().toISOString(),
                    selected_model: selectedModel || getStoredSetting("selected_model", "gemini-3.1-flash-lite-preview"),
                    active_api_provider: activeApiProvider || getStoredSetting("active_api_provider", "google"),
                    sf_locale: getStoredSetting("sf_locale", "en"),
                    sf_song_lang: getStoredSetting("sf_song_lang", "English"),
                    sf_song_lang_custom: getStoredSetting("sf_song_lang_custom", ""),
                };
            }

            function applySyncedSettingsPayload(payload, options = {}) {
                if (!payload || typeof payload !== "object") return;

                // Skip overwriting model/provider if the user changed them locally since the last
                // Drive write — the correct value is about to be pushed TO Drive, not pulled FROM it.
                if (payload.selected_model && !modelChangedLocally) {
                    selectedModel = payload.selected_model;
                    setStoredSetting("selected_model", payload.selected_model);
                }
                if (payload.active_api_provider && !modelChangedLocally) {
                    activeApiProvider = payload.active_api_provider;
                    setStoredSetting("active_api_provider", payload.active_api_provider);
                }
                if (payload.sf_locale) {
                    setStoredSetting("sf_locale", payload.sf_locale);
                }
                if (payload.sf_song_lang) {
                    setStoredSetting("sf_song_lang", payload.sf_song_lang);
                }
                if (payload.sf_song_lang_custom !== undefined) {
                    setStoredSetting("sf_song_lang_custom", payload.sf_song_lang_custom);
                }

                if (options.applyUi) {
                    applyStoredSongLanguagePreference();
                    // Apply locale if it was synced from Drive
                    const locale = getStoredSetting("sf_locale", "");
                    if (locale) {
                        const sel = document.getElementById("lang-select");
                        if (sel && sel.value !== locale) {
                            sel.value = locale;
                            window.I18N?.switchLocale?.(locale);
                        }
                    }
                    refreshCombinedModelList();
                    updateApiBarSummary();
                }
            }

            function escapeDriveQueryValue(value) {
                return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
            }

            function mergeHistoryCollections(base, incoming) {
                const combined = [...(Array.isArray(base) ? base : []), ...(Array.isArray(incoming) ? incoming : [])].filter(Boolean);
                const uniqueMap = new Map();

                combined.forEach((song, idx) => {
                    const key = `${song?.title || ""}|${song?.genre || ""}`;
                    const existing = uniqueMap.get(key);
                    const existingDate = new Date(existing?.savedAt || 0).getTime();
                    const candidateDate = new Date(song?.savedAt || 0).getTime();
                    const normalized = { ...song, id: song?.id || Date.now() + idx, savedAt: song?.savedAt || new Date().toISOString() };
                    if (!existing || candidateDate >= existingDate) uniqueMap.set(key, normalized);
                });

                return Array.from(uniqueMap.values()).sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
            }

            function getDriveStatusLabel() {
                if (storageProvider !== STORAGE_PROVIDER_DRIVE) return _t("status.storage_local", "local only");
                if (driveAccessToken && Date.now() < driveTokenExpiresAt - 60000) return _t("status.drive_connected", "connected");
                return _t("status.drive_disconnected", "not connected");
            }

            function setDriveSyncStatus(state) {
                // state: 'syncing' | 'ok' | 'failed'
                const driveStatus = document.getElementById("drive-storage-status");
                if (!driveStatus) return;
                if (state === "syncing") {
                    driveStatus.textContent = _t("status.drive_syncing", "syncing\u2026");
                    driveStatus.className = "api-status warn";
                } else if (state === "ok") {
                    const now = new Date();
                    const hhmm = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                    driveStatus.textContent = _fmt("status.drive_synced", "synced {0}", hhmm);
                    driveStatus.className = "api-status ok";
                } else if (state === "failed") {
                    driveStatus.textContent = _t("status.drive_sync_failed", "sync failed");
                    driveStatus.className = "api-status missing";
                }
            }

            function updateStorageControls() {
                const providerSelect = document.getElementById("storage-provider-select");
                const providerStatus = document.getElementById("storage-provider-status");
                const actionRow = document.getElementById("drive-storage-actions-row");
                const hintRow = document.getElementById("drive-storage-hint-row");
                const driveStatus = document.getElementById("drive-storage-status");

                if (providerSelect) providerSelect.value = storageProvider;

                const usingDrive = storageProvider === STORAGE_PROVIDER_DRIVE;
                if (actionRow) actionRow.style.display = usingDrive ? "flex" : "none";
                if (hintRow) hintRow.style.display = usingDrive ? "flex" : "none";

                if (providerStatus) {
                    providerStatus.textContent = usingDrive ? _t("status.storage_drive", "Drive sync") : _t("status.storage_local", "local only");
                    providerStatus.className = `api-status ${usingDrive ? "ok" : "missing"}`;
                }

                if (driveStatus) {
                    const isConnected = !!driveAccessToken && Date.now() < driveTokenExpiresAt - 60000;
                    if (lastDriveSyncAt && isConnected) {
                        const hhmm = lastDriveSyncAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                        driveStatus.textContent = _fmt("status.drive_synced", "synced {0}", hhmm);
                    } else {
                        driveStatus.textContent = getDriveStatusLabel();
                    }
                    driveStatus.className = `api-status ${isConnected ? "ok" : "warn"}`;
                }

                updateApiBarSummary();
            }

            function persistSyncedSettings() {
                setStoredSetting(STORAGE_PROVIDER_KEY, storageProvider);
                scheduleDriveSync();
            }

            async function waitForGoogleIdentityServices() {
                if (window.google?.accounts?.oauth2) return;
                await new Promise((resolve, reject) => {
                    const started = Date.now();
                    const timer = setInterval(() => {
                        if (window.google?.accounts?.oauth2) {
                            clearInterval(timer);
                            resolve();
                            return;
                        }
                        if (Date.now() - started > 10000) {
                            clearInterval(timer);
                            reject(new Error(_t("alert.drive_gis_unavailable", "Google Identity Services did not load.")));
                        }
                    }, 100);
                });
            }

            async function ensureDriveTokenClient() {
                await waitForGoogleIdentityServices();
                if (!driveTokenClient) {
                    driveTokenClient = google.accounts.oauth2.initTokenClient({
                        client_id: DRIVE_CLIENT_ID,
                        scope: DRIVE_SCOPE,
                        callback: () => {},
                    });
                }
            }

            async function ensureDriveAccessToken(interactive = false, options = {}) {
                const forcePrompt = !!options.forcePrompt;
                if (!forcePrompt && driveAccessToken && Date.now() < driveTokenExpiresAt - 60000) {
                    return driveAccessToken;
                }

                await ensureDriveTokenClient();

                return await new Promise((resolve, reject) => {
                    driveTokenClient.callback = (response) => {
                        if (!response || response.error) {
                            const message = response?.error_description || response?.error || _t("alert.drive_auth_failed", "Google Drive authorization failed.");
                            reject(new Error(message));
                            return;
                        }
                        driveAccessToken = response.access_token;
                        driveTokenExpiresAt = Date.now() + (response.expires_in || 3600) * 1000;
                        // Persist so page reload can restore token without a new OAuth popup
                        try {
                            sessionStorage.setItem(DRIVE_SESSION_TOKEN_KEY, JSON.stringify({ token: driveAccessToken, expiresAt: driveTokenExpiresAt }));
                        } catch (_) {}
                        updateStorageControls();
                        resolve(driveAccessToken);
                    };

                    try {
                        // Login button should always show the Google account + consent UI.
                        driveTokenClient.requestAccessToken({ prompt: interactive ? "select_account consent" : "" });
                    } catch (err) {
                        reject(err);
                    }
                });
            }

            async function driveApiRequest(url, init = {}, options = {}) {
                const token = await ensureDriveAccessToken(!!options.interactive);
                const headers = new Headers(init.headers || {});
                headers.set("Authorization", `Bearer ${token}`);

                const response = await fetch(url, { ...init, headers });
                if (!response.ok) {
                    const message = await response.text();
                    throw new Error(`Drive API ${response.status}: ${message.slice(0, 240)}`);
                }

                if (options.responseType === "text") {
                    return await response.text();
                }

                if (response.status === 204) return null;
                const text = await response.text();
                return text ? safeParseJSON(text) : null;
            }

            async function findDriveAppFile(fileName, interactive = false) {
                const query = encodeURIComponent(`name='${escapeDriveQueryValue(fileName)}'`);
                const result = await driveApiRequest(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name,modifiedTime)&pageSize=10&q=${query}`, {}, { interactive });
                return result?.files?.[0] || null;
            }

            async function readDriveJsonFile(fileName, interactive = false) {
                const existing = await findDriveAppFile(fileName, interactive);
                if (!existing?.id) return null;
                const text = await driveApiRequest(`https://www.googleapis.com/drive/v3/files/${existing.id}?alt=media`, {}, { interactive, responseType: "text" });
                return text ? safeParseJSON(text) : null;
            }

            async function writeDriveJsonFile(fileName, payload, interactive = false) {
                const existing = await findDriveAppFile(fileName, interactive);
                const bodyText = JSON.stringify(payload, null, 2);

                if (existing?.id) {
                    await driveApiRequest(
                        `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`,
                        {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: bodyText,
                        },
                        { interactive },
                    );
                    return existing.id;
                }

                const boundary = `sunoforge-${Date.now()}`;
                const multipartBody =
                    `--${boundary}\r\n` +
                    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
                    `${JSON.stringify({ name: fileName, parents: ["appDataFolder"], mimeType: "application/json" })}\r\n` +
                    `--${boundary}\r\n` +
                    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
                    `${bodyText}\r\n` +
                    `--${boundary}--`;

                const created = await driveApiRequest(
                    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name",
                    {
                        method: "POST",
                        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
                        body: multipartBody,
                    },
                    { interactive },
                );
                return created?.id || null;
            }

            async function hydrateDriveState(interactive = false) {
                const [remoteSettings, remoteHistory, remotePresets] = await Promise.all([readDriveJsonFile(DRIVE_SETTINGS_FILE, interactive), readDriveJsonFile(DRIVE_HISTORY_FILE, interactive), readDriveJsonFile(DRIVE_PRESETS_FILE, interactive)]);

                if (remoteSettings) {
                    // Drive settings take precedence — apply to both memory/localStorage and UI
                    applySyncedSettingsPayload(remoteSettings, { applyUi: true });
                }

                if (remoteHistory?.songs && Array.isArray(remoteHistory.songs)) {
                    history = mergeHistoryCollections(history, remoteHistory.songs);
                    persistHistory();
                }

                if (remotePresets?.presets && Array.isArray(remotePresets.presets)) {
                    songPresets = mergePresetsCollections(songPresets, remotePresets.presets);
                    try {
                        localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(songPresets));
                    } catch (_) {}
                    renderPresets();
                }
            }

            async function syncDriveAppState(options = {}) {
                const interactive = !!options.interactive;
                const showAlert = !!options.showAlert;

                if (storageProvider !== STORAGE_PROVIDER_DRIVE) return;

                if (driveSyncInFlight) {
                    return driveSyncInFlight;
                }

                driveSyncInFlight = (async () => {
                    setDriveSyncStatus("syncing");
                    await ensureDriveAccessToken(interactive);
                    await hydrateDriveState(interactive);
                    await writeDriveJsonFile(DRIVE_HISTORY_FILE, { version: 1, savedAt: new Date().toISOString(), songs: history }, interactive);
                    await writeDriveJsonFile(DRIVE_SETTINGS_FILE, buildSyncedSettingsPayload(), interactive);
                    modelChangedLocally = false; // local model is now safely in Drive; allow future syncs to apply remote changes
                    await writeDriveJsonFile(DRIVE_PRESETS_FILE, { version: 1, savedAt: new Date().toISOString(), presets: songPresets }, interactive);
                    lastDriveSyncAt = new Date();
                    updateStorageControls();
                    if (showAlert) {
                        alert(_t("alert.drive_sync_success", "Google Drive sync completed."));
                    }
                })();

                try {
                    await driveSyncInFlight;
                } finally {
                    driveSyncInFlight = null;
                }
            }

            function scheduleDriveSync() {
                if (storageProvider !== STORAGE_PROVIDER_DRIVE || !driveAccessToken) return;
                clearTimeout(driveSyncTimer);
                driveSyncTimer = setTimeout(() => {
                    syncDriveAppState().catch((err) => {
                        console.warn("Drive sync failed:", err);
                        setDriveSyncStatus("failed");
                    });
                }, 500);
            }

            function setStorageProvider(provider) {
                storageProvider = provider === STORAGE_PROVIDER_DRIVE ? STORAGE_PROVIDER_DRIVE : STORAGE_PROVIDER_LOCAL;
                setStoredSetting(STORAGE_PROVIDER_KEY, storageProvider);
                updateStorageControls();
                persistSyncedSettings();
            }

            async function connectDriveStorage() {
                try {
                    storageProvider = STORAGE_PROVIDER_DRIVE;
                    setStoredSetting(STORAGE_PROVIDER_KEY, storageProvider);
                    updateStorageControls();
                    await syncDriveAppState({ interactive: true, showAlert: true });
                    applyStoredSongLanguagePreference();
                    renderHistory();
                } catch (err) {
                    console.error("Drive connect failed:", err);
                    updateStorageControls();
                    alert(_fmt("alert.drive_connect_failed", "Could not connect to Google Drive.\n\nError: {0}", err.message));
                }
            }

            async function loginDriveStorage() {
                try {
                    storageProvider = STORAGE_PROVIDER_DRIVE;
                    setStoredSetting(STORAGE_PROVIDER_KEY, storageProvider);
                    driveTokenClient = null;
                    await ensureDriveAccessToken(true, { forcePrompt: true });
                    updateStorageControls();
                } catch (err) {
                    console.error("Drive login failed:", err);
                    updateStorageControls();
                    alert(_fmt("alert.drive_login_failed", "Could not log in to Google Drive.\n\nError: {0}", err.message));
                }
            }

            async function syncDriveStorageNow() {
                try {
                    await syncDriveAppState({ interactive: true, showAlert: true });
                    applyStoredSongLanguagePreference();
                    renderHistory();
                } catch (err) {
                    console.error("Drive sync failed:", err);
                    updateStorageControls();
                    alert(_fmt("alert.drive_sync_failed", "Google Drive sync failed.\n\nError: {0}", err.message));
                }
            }

            function disconnectDriveStorage() {
                if (driveAccessToken && window.google?.accounts?.oauth2?.revoke) {
                    try {
                        google.accounts.oauth2.revoke(driveAccessToken, () => {});
                    } catch (err) {
                        console.warn("Drive revoke failed:", err);
                    }
                }
                driveAccessToken = null;
                driveTokenExpiresAt = 0;
                try {
                    sessionStorage.removeItem(DRIVE_SESSION_TOKEN_KEY);
                } catch (_) {}
                updateStorageControls();
            }

            function applyStoredSongLanguagePreference() {
                const savedLang = localStorage.getItem("sf_song_lang");
                const customLang = localStorage.getItem("sf_song_lang_custom") || "";
                if (savedLang) {
                    applySongLanguageSetting(savedLang);
                    const customInput = document.getElementById("song-language-custom");
                    if (customInput && savedLang === "custom") {
                        customInput.style.display = "";
                        customInput.value = customLang;
                    }
                }
            }

            function saveSongLanguageCustom(value) {
                setStoredSetting("sf_song_lang_custom", value.trim());
                persistSyncedSettings();
            }

            // Unified AI call — routes to Google GenAI or OpenRouter REST based on selected model's provider
            async function callAI(prompt) {
                const model = document.getElementById("model-select")?.value || selectedModel;
                const provider = modelProviderMap[model] || activeApiProvider;
                // Local OpenAI-compatible LLM server branch (LM Studio, Ollama, vLLM, etc.)
                if (provider === "custom") {
                    const addr = localStorage.getItem("custom_server_address");
                    if (!addr) throw new Error("Local OpenAI compatible LLM server address not set — enter it in the API bar.");
                    const key = localStorage.getItem("custom_server_key");
                    const headers = { "Content-Type": "application/json" };
                    if (key) headers["Authorization"] = "Bearer " + key;
                    const resp = await fetch(addr.replace(/\/$/, "") + "/v1/chat/completions", {
                        method: "POST",
                        headers,
                        body: JSON.stringify({
                            model: model,
                            messages: [{ role: "user", content: prompt }],
                        }),
                    });
                    if (!resp.ok) {
                        const errText = await resp.text();
                        throw new Error("Local LLM server error " + resp.status + ": " + errText.slice(0, 200));
                    }
                    const data = await resp.json();
                    return { text: data.choices?.[0]?.message?.content || "" };
                } else if (provider === "openrouter") {
                    const key = localStorage.getItem("openrouter_api_key");
                    if (!key) throw new Error("OpenRouter key not set — enter your key in the API Key bar.");
                    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: "Bearer " + key,
                            "HTTP-Referer": location.href,
                            "X-Title": "SunoForge",
                        },
                        body: JSON.stringify({
                            model: model,
                            messages: [{ role: "user", content: prompt }],
                        }),
                    });
                    if (!resp.ok) {
                        const errText = await resp.text();
                        throw new Error("OpenRouter error " + resp.status + ": " + errText.slice(0, 200));
                    }
                    const data = await resp.json();
                    return { text: data.choices?.[0]?.message?.content || "" };
                } else {
                    if (!aiClient) throw new Error("Google AI key not set — enter your key in the API Key bar.");
                    const response = await aiClient.models.generateContent({ model: model, contents: prompt });
                    return { text: response.text };
                }
            }

            // Fetch available models from Google AI and populate the model selector
            async function fetchGoogleModels(apiKey) {
                try {
                    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
                    if (!resp.ok) throw new Error("HTTP " + resp.status);
                    const data = await resp.json();
                    const models = (data.models || []).filter((m) => m.name && m.supportedGenerationMethods?.includes("generateContent"));
                    if (models.length === 0) throw new Error("No models returned");
                    googleModels = models.map((m) => ({ id: m.name.replace("models/", ""), label: m.displayName || m.name.replace("models/", ""), provider: "Google" }));
                } catch (err) {
                    console.warn("Could not fetch Google models:", err);
                    googleModels = [{ id: "gemini-3.1-flash-lite-preview", label: "gemini-3.1-flash-lite-preview", provider: "Google" }];
                }
                refreshCombinedModelList();
            }

            // Fetch available models from OpenRouter and populate the model selector
            async function fetchOpenRouterModels(apiKey) {
                try {
                    const resp = await fetch("https://openrouter.ai/api/v1/models", {
                        headers: { Authorization: "Bearer " + apiKey },
                    });
                    if (!resp.ok) throw new Error("HTTP " + resp.status);
                    const data = await resp.json();
                    const models = data.data || [];
                    if (models.length === 0) throw new Error("No models returned");
                    // Only keep chat/text-output models — exclude image generators and agentic-only models
                    // architecture.modality is formatted as "input->output"; keep where output includes "text"
                    openrouterModels = models
                        .filter((m) => {
                            const output = (m.architecture?.modality || "text->text").split("->")[1] || "";
                            return output.includes("text");
                        })
                        .map((m) => ({ id: m.id, label: m.name || m.id, provider: "OpenRouter" }));
                } catch (err) {
                    console.warn("Could not fetch OpenRouter models:", err);
                    openrouterModels = [{ id: "gemini-3.1-flash-lite-preview", label: "gemini-3.1-flash-lite-preview (fallback)", provider: "OpenRouter" }];
                }
                refreshCombinedModelList();
            }

            // Merge Google (first) + OpenRouter models into one list and repopulate the selector
            function refreshCombinedModelList() {
                const csModels = customServerModels.map((id) => ({ id, label: id, provider: "Custom" }));
                const manualModels = customModels.filter((id) => !customServerModels.includes(id)).map((id) => ({ id, label: id + " (manual)", provider: "Custom" }));
                const combined = [...csModels, ...manualModels, ...googleModels, ...openrouterModels];
                if (combined.length === 0) return;
                // Build provider map for callAI routing
                modelProviderMap = {};
                combined.forEach((m) => {
                    if (m.provider === "Google") modelProviderMap[m.id] = "google";
                    else if (m.provider === "OpenRouter") modelProviderMap[m.id] = "openrouter";
                    else if (m.provider === "Custom") modelProviderMap[m.id] = "custom";
                });
                // Prioritise the JS variable (seeded from localStorage on startup) over the
                // DOM element, whose value is just the hardcoded placeholder until lists load
                const currentVal = selectedModel || document.getElementById("model-select")?.value;
                const hasCurrentVal = combined.some((m) => m.id === currentVal);
                let defaultId = hasCurrentVal ? currentVal : null;
                if (!defaultId) {
                    const preferredIds = ["gemini-3.1-flash-lite-preview", "google/gemini-2.0-flash-lite", "google/gemini-flash-lite"];
                    const fuzzy = combined.find((m) => {
                        const id = m.id.toLowerCase();
                        return id.includes("gemini") && id.includes("flash") && (id.includes("lite") || id.includes("light"));
                    });
                    defaultId = preferredIds.find((pid) => combined.some((m) => m.id === pid)) || (fuzzy && fuzzy.id) || combined[0].id;
                }
                applyModelList(combined, defaultId);
            }

            // Populate custom searchable model dropdown from a list and set the default selection
            function applyModelList(models, defaultId) {
                const list = document.getElementById("model-select-list");
                if (!list) return;
                list.innerHTML = "";
                let matched = false;
                let defaultLabel = "";
                models.forEach((m) => {
                    const label = m.label + (m.provider ? " (" + m.provider + ")" : "");
                    const div = document.createElement("div");
                    div.className = "model-option";
                    div.dataset.value = m.id;
                    div.textContent = label;
                    div.addEventListener("click", () => selectModel(m.id, label));
                    if (m.id === defaultId) {
                        div.classList.add("active");
                        matched = true;
                        defaultLabel = label;
                    }
                    list.appendChild(div);
                });
                if (!matched && list.children.length > 0) {
                    const first = list.children[0];
                    first.classList.add("active");
                    defaultLabel = first.textContent;
                    defaultId = first.dataset.value;
                }
                // Update hidden input and display label — mirrors old <select> value setting.
                // Do NOT touch selectedModel or localStorage here — owned by init/selectModel.
                const hidden = document.getElementById("model-select");
                if (hidden) hidden.value = defaultId || "";
                const labelEl = document.getElementById("model-select-label");
                if (labelEl && defaultLabel) labelEl.textContent = defaultLabel;
                updateApiBarSummary();
            }

            // Toggle the custom model dropdown open/closed
            function toggleModelDropdown(e) {
                const dd = document.getElementById("model-select-dropdown");
                const filter = document.getElementById("model-select-filter");
                if (dd.style.display === "none") {
                    dd.style.display = "";
                    filter.value = "";
                    filterModelOptions("");
                    filter.focus();
                } else {
                    dd.style.display = "none";
                }
                e.stopPropagation();
            }

            // Filter visible options in the model dropdown to those matching the query
            function filterModelOptions(query) {
                const q = query.trim().toLowerCase();
                document.querySelectorAll("#model-select-list .model-option").forEach((item) => {
                    item.style.display = !q || item.textContent.toLowerCase().includes(q) ? "" : "none";
                });
            }

            // On Enter in filter input, click the first visible option
            function modelFilterKeydown(e) {
                if (e.key === "Enter") {
                    const first = Array.from(document.querySelectorAll("#model-select-list .model-option")).find((el) => el.style.display !== "none");
                    if (first) first.click();
                }
            }

            // Select a model from the custom dropdown and persist to localStorage
            function selectModel(id, label) {
                const hidden = document.getElementById("model-select");
                if (hidden) hidden.value = id;
                const labelEl = document.getElementById("model-select-label");
                if (labelEl) labelEl.textContent = label;
                selectedModel = id;
                localStorage.setItem("selected_model", id);
                activeApiProvider = modelProviderMap[id] || activeApiProvider;
                localStorage.setItem("active_api_provider", activeApiProvider);
                modelChangedLocally = true; // protect this selection from being overwritten by the Drive hydrate step
                document.getElementById("model-select-dropdown").style.display = "none";
                document.querySelectorAll("#model-select-list .model-option").forEach((el) => {
                    el.classList.toggle("active", el.dataset.value === id);
                });
                updateApiBarSummary();
                persistSyncedSettings();
            }

            // Security: HTML escape utility to prevent XSS attacks
            // Converts dangerous characters to HTML entities
            function escapeHtml(unsafe) {
                if (unsafe === null || unsafe === undefined) return "";
                return String(unsafe).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
            }

            // Parses AI-returned JSON that may contain literal newlines/tabs inside string values.
            // Walks character-by-character so it only escapes control characters that appear
            // inside a JSON string literal, leaving the structural punctuation untouched.
            function safeParseJSON(text) {
                let out = "";
                let inString = false;
                let escaped = false;
                for (let i = 0; i < text.length; i++) {
                    const ch = text[i];
                    if (escaped) {
                        out += ch;
                        escaped = false;
                        continue;
                    }
                    if (ch === "\\") {
                        escaped = true;
                        out += ch;
                        continue;
                    }
                    if (ch === '"') {
                        inString = !inString;
                        out += ch;
                        continue;
                    }
                    if (inString) {
                        if (ch === "\n") {
                            out += "\\n";
                            continue;
                        }
                        if (ch === "\r") {
                            out += "\\r";
                            continue;
                        }
                        if (ch === "\t") {
                            out += "\\t";
                            continue;
                        }
                    }
                    out += ch;
                }
                return JSON.parse(out);
            }

            // Security: Sanitize for attribute values
            function escapeAttr(unsafe) {
                if (unsafe === null || unsafe === undefined) return "";
                return String(unsafe).replace(/"/g, "&quot;").replace(/'/g, "&#039;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            }

            // Security: Validate and limit input length
            function validateInput(input, maxLength = 10000) {
                if (typeof input !== "string") return "";
                return input.slice(0, maxLength);
            }

            function saveApiKey() {
                const key = document.getElementById("api-key-input").value.trim();
                const st = document.getElementById("api-status");
                if (!key) {
                    localStorage.removeItem("gemini_api_key");
                    aiClient = null;
                    st.textContent = "not set";
                    st.className = "api-status missing";
                    document.getElementById("api-key-get-link").style.display = "";
                    if (activeApiProvider === "google") {
                        activeApiProvider = localStorage.getItem("openrouter_api_key") ? "openrouter" : localStorage.getItem("custom_server_address") ? "custom" : "google";
                    }
                    const hasAny = localStorage.getItem("openrouter_api_key") || localStorage.getItem("custom_server_address");
                    if (!hasAny) document.getElementById("api-no-key-hint").style.display = "";
                    updateApiBarSummary();
                    return;
                }
                // Security: Warn about localStorage
                console.warn("WARNING: API key is stored in browser localStorage (not encrypted). Only use this application on trusted devices.");
                localStorage.setItem("gemini_api_key", key);
                aiClient = new GoogleGenAI({ apiKey: key });
                activeApiProvider = "google";
                document.getElementById("api-no-key-hint").style.display = "none";
                st.textContent = _t("status.ready", "ready");
                st.className = "api-status ok";
                document.getElementById("api-key-get-link").style.display = "none";
                fetchGoogleModels(key);
                updateApiBarSummary();
                toggleApiBar(false);
            }

            function saveOpenRouterKey() {
                const key = document.getElementById("openrouter-key-input").value.trim();
                const st = document.getElementById("openrouter-status");
                if (!key) {
                    localStorage.removeItem("openrouter_api_key");
                    openrouterModels = [];
                    refreshCombinedModelList();
                    st.textContent = "not set";
                    st.className = "api-status missing";
                    document.getElementById("openrouter-get-link").style.display = "";
                    if (activeApiProvider === "openrouter") {
                        activeApiProvider = localStorage.getItem("gemini_api_key") ? "google" : localStorage.getItem("custom_server_address") ? "custom" : "google";
                    }
                    const hasAny = localStorage.getItem("gemini_api_key") || localStorage.getItem("custom_server_address");
                    if (!hasAny) document.getElementById("api-no-key-hint").style.display = "";
                    updateApiBarSummary();
                    return;
                }
                console.warn("WARNING: API key is stored in browser localStorage (not encrypted). Only use this application on trusted devices.");
                localStorage.setItem("openrouter_api_key", key);
                activeApiProvider = "openrouter";
                document.getElementById("api-no-key-hint").style.display = "none";
                st.textContent = _t("status.ready", "ready");
                st.className = "api-status ok";
                document.getElementById("openrouter-get-link").style.display = "none";
                fetchOpenRouterModels(key);
                updateApiBarSummary();
                toggleApiBar(false);
            }

            function saveCustomServer() {
                const addr = document.getElementById("custom-server-input").value.trim().replace(/\/$/, "");
                const st = document.getElementById("custom-server-status");
                if (!addr) {
                    localStorage.removeItem("custom_server_address");
                    localStorage.removeItem("custom_server_key");
                    document.getElementById("custom-server-key-input").value = "";
                    customServerAddress = "";
                    customServerModels = [];
                    customModels = customModels.filter((id) => modelProviderMap[id] !== "custom");
                    localStorage.setItem("custom_models", JSON.stringify(customModels));
                    refreshCombinedModelList();
                    st.textContent = "not set";
                    st.className = "api-status missing";
                    if (activeApiProvider === "custom") {
                        activeApiProvider = localStorage.getItem("gemini_api_key") ? "google" : localStorage.getItem("openrouter_api_key") ? "openrouter" : "google";
                        localStorage.setItem("active_api_provider", activeApiProvider);
                    }
                    const hasAny = localStorage.getItem("gemini_api_key") || localStorage.getItem("openrouter_api_key");
                    if (!hasAny) document.getElementById("api-no-key-hint").style.display = "";
                    updateApiBarSummary();
                    return;
                }
                try {
                    new URL(addr);
                } catch {
                    alert("Please enter a valid URL (e.g. http://localhost:1234).");
                    return;
                }
                localStorage.setItem("custom_server_address", addr);
                customServerAddress = addr;
                const key = document.getElementById("custom-server-key-input").value.trim();
                if (key) {
                    localStorage.setItem("custom_server_key", key);
                } else {
                    localStorage.removeItem("custom_server_key");
                }
                activeApiProvider = "custom";
                localStorage.setItem("active_api_provider", "custom");
                document.getElementById("api-no-key-hint").style.display = "none";
                st.textContent = "saved";
                st.className = "api-status ok";
                customModels.forEach((id) => {
                    modelProviderMap[id] = "custom";
                });
                fetchCustomServerModels(addr);
                updateApiBarSummary();
                toggleApiBar(false);
            }

            async function fetchCustomServerModels(addr) {
                const url = (addr || customServerAddress || localStorage.getItem("custom_server_address") || "").replace(/\/$/, "");
                if (!url) {
                    alert("Save a server address first.");
                    return;
                }
                const st = document.getElementById("custom-server-status");
                st.textContent = "fetching...";
                st.className = "api-status";
                try {
                    const fetchKey = localStorage.getItem("custom_server_key");
                    const fetchHeaders = fetchKey ? { Authorization: "Bearer " + fetchKey } : undefined;
                    const resp = await fetch(url + "/v1/models", fetchHeaders ? { headers: fetchHeaders } : undefined);
                    if (!resp.ok) throw new Error("HTTP " + resp.status);
                    const data = await resp.json();
                    const ids = (data.data || []).map((m) => m.id).filter(Boolean);
                    if (ids.length === 0) throw new Error("No models returned — is the server running with a model loaded?");
                    customServerModels = ids;
                    ids.forEach((id) => {
                        modelProviderMap[id] = "custom";
                    });
                    refreshCombinedModelList();
                    const current = document.getElementById("model-select")?.value;
                    if (!customServerModels.includes(current) && !customModels.includes(current)) {
                        selectModel(ids[0], ids[0]);
                    }
                    st.textContent = ids.length + " model" + (ids.length !== 1 ? "s" : "");
                    st.className = "api-status ok";
                } catch (err) {
                    console.error("fetchCustomServerModels error:", err);
                    st.textContent = "fetch failed";
                    st.className = "api-status missing";
                    alert("Could not fetch models from " + url + "\n\nMake sure the local OpenAI compatible LLM server is running.\n\nError: " + err.message);
                }
                updateApiBarSummary();
            }

            function toggleApiBar(forceOpen) {
                const body = document.getElementById("api-bar-body");
                const chevron = document.getElementById("api-bar-chevron");
                const open = forceOpen !== undefined ? forceOpen : body.style.display === "none";
                body.style.display = open ? "flex" : "none";
                if (chevron) chevron.style.transform = open ? "rotate(0deg)" : "rotate(-90deg)";
            }

            function updateApiBarSummary() {
                const modelLabel = document.getElementById("model-select-label")?.textContent || "";
                const el = document.getElementById("api-bar-summary-model");
                if (el) el.textContent = modelLabel;
                const googleOk = !!localStorage.getItem("gemini_api_key");
                const orOk = !!localStorage.getItem("openrouter_api_key");
                const csOk = !!localStorage.getItem("custom_server_address");
                const sg = document.getElementById("api-bar-sum-google");
                const so = document.getElementById("api-bar-sum-or");
                const sc = document.getElementById("api-bar-sum-custom");
                const sd = document.getElementById("api-bar-sum-drive");
                if (sg) {
                    sg.textContent = "Google";
                    sg.className = "api-status " + (googleOk ? "ok" : "missing");
                }
                if (so) {
                    so.textContent = "OR";
                    so.className = "api-status " + (orOk ? "ok" : "missing");
                }
                if (sc) {
                    sc.textContent = "LLM";
                    sc.className = "api-status " + (csOk ? "ok" : "missing");
                }
                if (sd) {
                    const usingDrive = storageProvider === STORAGE_PROVIDER_DRIVE;
                    sd.style.display = usingDrive ? "" : "none";
                    if (usingDrive) {
                        const driveConnected = !!driveAccessToken && Date.now() < driveTokenExpiresAt - 60000;
                        if (driveConnected && lastDriveSyncAt) {
                            const hhmm = lastDriveSyncAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                            sd.textContent = _fmt("status.drive_synced", "Synced {0}", hhmm);
                            sd.className = "api-status ok";
                        } else if (driveConnected) {
                            sd.textContent = _t("status.drive_connected", "Drive");
                            sd.className = "api-status ok";
                        } else {
                            sd.textContent = _t("status.drive_disconnected", "Drive");
                            sd.className = "api-status warn";
                        }
                    }
                }
            }

            // Auto-load saved API key on startup
            // Security warning: API keys in localStorage are not encrypted
            (function () {
                const saved = localStorage.getItem("gemini_api_key");
                if (saved) {
                    document.getElementById("api-no-key-hint").style.display = "none";
                    document.getElementById("api-key-input").value = saved;
                    aiClient = new GoogleGenAI({ apiKey: saved });
                    activeApiProvider = "google";
                    const st = document.getElementById("api-status");
                    st.textContent = _t("status.ready", "ready");
                    st.className = "api-status ok";
                    document.getElementById("api-key-get-link").style.display = "none";
                    // Fetch models asynchronously after DOM is ready
                    fetchGoogleModels(saved);
                }
                const orKey = localStorage.getItem("openrouter_api_key");
                if (orKey) {
                    document.getElementById("api-no-key-hint").style.display = "none";
                    document.getElementById("openrouter-key-input").value = orKey;
                    const ost = document.getElementById("openrouter-status");
                    ost.textContent = _t("status.ready", "ready");
                    ost.className = "api-status ok";
                    document.getElementById("openrouter-get-link").style.display = "none";
                    if (!saved) activeApiProvider = "openrouter";
                    fetchOpenRouterModels(orKey);
                }
                // Restore custom server address and auto-fetch models
                const csAddr = localStorage.getItem("custom_server_address");
                if (csAddr) {
                    customServerAddress = csAddr;
                    document.getElementById("custom-server-input").value = csAddr;
                    document.getElementById("api-no-key-hint").style.display = "none";
                    if (!saved && !orKey) activeApiProvider = "custom";
                    customModels.forEach((id) => {
                        modelProviderMap[id] = "custom";
                    });
                    if (customModels.length) refreshCombinedModelList();
                    fetchCustomServerModels(csAddr);
                }
                const csKey = localStorage.getItem("custom_server_key");
                if (csKey) document.getElementById("custom-server-key-input").value = csKey;
                updateApiBarSummary();
                toggleApiBar(!(saved || orKey || csAddr));
            })();

            // Close model dropdown on outside click or Escape key
            document.addEventListener("click", (e) => {
                const wrap = document.getElementById("model-select-wrap");
                if (wrap && !wrap.contains(e.target)) {
                    const dd = document.getElementById("model-select-dropdown");
                    if (dd) dd.style.display = "none";
                }
            });
            document.addEventListener("keydown", (e) => {
                if (e.key === "Escape") {
                    const dd = document.getElementById("model-select-dropdown");
                    if (dd && dd.style.display !== "none") {
                        dd.style.display = "none";
                        document.getElementById("model-select-btn")?.focus();
                    }
                }
            });

            // ========================================================================
            // Custom Tag System
            // Handles dynamic tag creation and management for multi-select fields
            // ========================================================================
            // Show custom input field for manual entry
            function showCustomInput(tagRowId, inputRowId) {
                document.getElementById(inputRowId).style.display = "flex";
                const inputId = inputRowId.replace("-row", "-input");
                const inp = document.getElementById(inputId);
                if (inp) {
                    inp.value = "";
                    inp.focus();
                }
            }
            // Hide custom input field and clear its value
            function hideCustomInput(inputRowId, inputId) {
                document.getElementById(inputRowId).style.display = "none";
                if (inputId) document.getElementById(inputId).value = "";
            }
            // Confirm and add custom tag value to tag row
            function confirmCustomTag(tagRowId, inputId, inputRowId) {
                const inp = document.getElementById(inputId);
                const val = inp.value.trim();
                if (!val) return;
                if (tagRowId === "vocalgender-tags") {
                    const aiChooseTag = document.querySelector('#vocalgender-tags .tag[data-val="AI Choose"]');
                    if (aiChooseTag) aiChooseTag.classList.remove("active");
                }
                if (tagRowId === "genre-tags") {
                    // Deselect all preset genre tags
                    document
                        .getElementById("genre-tags")
                        .querySelectorAll(".tag")
                        .forEach((t) => t.classList.remove("active"));
                    // Set the custom genre value
                    setCustomSingleValue("genre-custom-row", "genre-custom-tag", "Custom genre", val);
                    hideCustomInput(inputRowId, inputId);
                    return;
                }
                addCustomTagToRow(tagRowId, val);
                hideCustomInput(inputRowId, inputId);
            }
            function confirmCustomSingleValue(inputId, inputRowId, rowId, tagId, prefix, groupId) {
                const inp = document.getElementById(inputId);
                const val = inp?.value?.trim();
                if (!val) return;
                const group = document.getElementById(groupId);
                if (group) {
                    group.querySelectorAll(".tag").forEach((t) => t.classList.remove("active"));
                }
                setCustomSingleValue(rowId, tagId, prefix, val);
                hideCustomInput(inputRowId, inputId);
            }
            // Clear all custom tags from specified tag row
            function clearCustomTagsInRow(tagRowId) {
                const row = document.getElementById(tagRowId);
                if (!row) return;
                row.querySelectorAll(".tag-custom").forEach((el) => el.remove());
            }
            // Remove custom tag when user clicks the X button
            function removeCustomTag(xEl) {
                const chip = xEl.parentElement;
                const row = chip?.parentElement;
                chip?.remove();
                if (row?.id === "vocalgender-tags") {
                    const hasSelections = getActiveMulti("vocalgender-tags").some((v) => v !== "AI Choose");
                    const aiChooseTag = document.querySelector('#vocalgender-tags .tag[data-val="AI Choose"]');
                    if (!hasSelections && aiChooseTag) aiChooseTag.classList.add("active");
                }
            }

            // Custom vocal range functions
            function showCustomRangeInput(idx) {
                const customRow = document.getElementById(`vp-custom-range-row-${idx}`);
                const input = document.getElementById(`vp-custom-range-input-${idx}`);
                if (customRow) customRow.style.display = "block";
                if (input) {
                    input.value = "";
                    input.focus();
                }
            }

            function hideCustomRangeInput(idx) {
                const customRow = document.getElementById(`vp-custom-range-row-${idx}`);
                if (customRow) customRow.style.display = "none";
            }

            function confirmCustomRange(idx) {
                const input = document.getElementById(`vp-custom-range-input-${idx}`);
                const rangeSelect = document.querySelector(`.vp-range[data-idx="${idx}"]`);
                const customValue = input?.value?.trim();

                if (!customValue) return;

                // Add custom option if it doesn't exist
                let customOption = rangeSelect.querySelector(`option[value="${escapeAttr(customValue)}"]`);
                if (!customOption) {
                    customOption = document.createElement("option");
                    customOption.value = customValue;
                    customOption.textContent = customValue;
                    // Insert before the "+ Custom Range..." option
                    const customMarker = rangeSelect.querySelector('option[value="__custom__"]');
                    rangeSelect.insertBefore(customOption, customMarker);
                }

                // Select the custom range
                rangeSelect.value = customValue;

                // Hide the input
                hideCustomRangeInput(idx);
            }

            function cancelCustomRange(idx) {
                const rangeSelect = document.querySelector(`.vp-range[data-idx="${idx}"]`);
                const input = document.getElementById(`vp-custom-range-input-${idx}`);

                // Reset to "Not specified"
                rangeSelect.value = "";
                input.value = "";

                // Hide the input
                hideCustomRangeInput(idx);
            }

            // ========================================================================
            // Genre Metadata - Comprehensive genre and sub-genre definitions
            // Imported from genre.js for consistency across the application
            // ========================================================================
            const GENRE_METADATA = [
                {
                    id: "pop",
                    name: "Pop",
                    description: "Modern contemporary pop",
                    subOptions: [
                        {
                            id: "pop_dream",
                            name: "Dream Pop",
                        },
                        {
                            id: "pop_kpop",
                            name: "K-Pop",
                        },
                        {
                            id: "pop_main",
                            name: "Pop",
                        },
                        {
                            id: "pop_electro",
                            name: "Electropop",
                        },
                        {
                            id: "pop_chamber",
                            name: "Chamber Pop",
                        },
                        {
                            id: "pop_indie",
                            name: "Indie Pop",
                        },
                        {
                            id: "pop_bubblegum",
                            name: "Bubblegum Pop",
                        },
                        {
                            id: "pop_dark",
                            name: "Dark Pop",
                        },
                        {
                            id: "pop_alternative",
                            name: "Alternative Pop",
                        },
                        {
                            id: "pop_jpop",
                            name: "J-Pop",
                        },
                        {
                            id: "pop_synth",
                            name: "Synthpop",
                        },
                    ],
                },
                {
                    id: "rock",
                    name: "Rock",
                    description: "Rock and alternative",
                    subOptions: [
                        {
                            id: "rock_psychedelic",
                            name: "Psychedelic Rock",
                        },
                        {
                            id: "rock_garage",
                            name: "Garage Rock",
                        },
                        {
                            id: "rock_80s",
                            name: "80s Rock",
                        },
                        {
                            id: "rock_main",
                            name: "Rock",
                        },
                        {
                            id: "rock_southern",
                            name: "Southern Rock",
                        },
                        {
                            id: "rock_indie",
                            name: "Indie Rock",
                        },
                        {
                            id: "rock_blues",
                            name: "Blues Rock",
                        },
                        {
                            id: "rock_grunge",
                            name: "Grunge",
                        },
                        {
                            id: "rock_surf",
                            name: "Surf Rock",
                        },
                        {
                            id: "rock_punk",
                            name: "Punk",
                        },
                        {
                            id: "rock_90s",
                            name: "90s Rock",
                        },
                        {
                            id: "rock_alternative",
                            name: "Alternative Rock",
                        },
                        {
                            id: "rock_americana",
                            name: "American Rock",
                        },
                        {
                            id: "rock_post",
                            name: "Post-Rock",
                        },
                        {
                            id: "rock_rockabilly",
                            name: "Rockabilly",
                        },
                        {
                            id: "rock_punkrock",
                            name: "Punk Rock",
                        },
                        {
                            id: "rock_70s",
                            name: "70s Rock",
                        },
                        {
                            id: "rock_roll",
                            name: "Rock & Roll",
                        },
                    ],
                },
                {
                    id: "metal",
                    name: "Metal",
                    description: "Heavy metal and subgenres",
                    subOptions: [
                        {
                            id: "mtl_symphonic",
                            name: "Symphonic Metal",
                        },
                        {
                            id: "mtl_doom",
                            name: "Doom Metal",
                        },
                        {
                            id: "mtl_main",
                            name: "Metal",
                        },
                        {
                            id: "mtl_black",
                            name: "Black Metal",
                        },
                        {
                            id: "mtl_progressive",
                            name: "Progressive Metal",
                        },
                        {
                            id: "mtl_thrash",
                            name: "Thrash Metal",
                        },
                        {
                            id: "mtl_post",
                            name: "Post-Metal",
                        },
                        {
                            id: "mtl_heavy",
                            name: "Heavy Metal",
                        },
                        {
                            id: "mtl_power",
                            name: "Power Metal",
                        },
                        {
                            id: "mtl_nu",
                            name: "Nu-Metal",
                        },
                        {
                            id: "mtl_death",
                            name: "Death Metal",
                        },
                    ],
                },
                {
                    id: "hip-hop",
                    name: "Hip-Hop",
                    description: "Hip-hop and rap",
                    subOptions: [
                        {
                            id: "hiphop_drill",
                            name: "Drill",
                        },
                        {
                            id: "hiphop_conscious",
                            name: "Conscious Rap",
                        },
                        {
                            id: "hiphop_main",
                            name: "Hip-Hop",
                        },
                        {
                            id: "hiphop_phonk",
                            name: "Phonk",
                        },
                        {
                            id: "hiphop_cloud",
                            name: "Cloud Rap",
                        },
                        {
                            id: "hiphop_boombap",
                            name: "Boom Bap",
                        },
                        {
                            id: "hiphop_oldschool",
                            name: "Old School Hip-Hop",
                        },
                        {
                            id: "hiphop_trap",
                            name: "Trap",
                        },
                        {
                            id: "hiphop_lofi",
                            name: "Lo-Fi Hip-Hop",
                        },
                        {
                            id: "hiphop_gangsta",
                            name: "Gangsta Rap",
                        },
                    ],
                },
                {
                    id: "rnb-soul",
                    name: "R&B / Soul",
                    description: "Rhythm & Blues and Soul",
                    subOptions: [
                        {
                            id: "rnb_funk",
                            name: "Funk",
                        },
                        {
                            id: "rnb_main",
                            name: "R&B",
                        },
                        {
                            id: "rnb_contemporary",
                            name: "Contemporary R&B",
                        },
                        {
                            id: "rnb_neosoul",
                            name: "Neo-Soul",
                        },
                        {
                            id: "rnb_gospel",
                            name: "Gospel",
                        },
                        {
                            id: "rnb_soul",
                            name: "Soul",
                        },
                        {
                            id: "rnb_motown",
                            name: "Motown",
                        },
                    ],
                },
                {
                    id: "jazz",
                    name: "Jazz",
                    description: "Jazz and its variants",
                    subOptions: [
                        {
                            id: "jz_acid",
                            name: "Acid Jazz",
                        },
                        {
                            id: "jz_main",
                            name: "Jazz",
                        },
                        {
                            id: "jz_latin",
                            name: "Latin Jazz",
                        },
                        {
                            id: "jz_bigband",
                            name: "Big Band",
                        },
                        {
                            id: "jz_swing",
                            name: "Swing",
                        },
                        {
                            id: "jz_nu",
                            name: "Nu-Jazz",
                        },
                        {
                            id: "jz_bebop",
                            name: "Bebop",
                        },
                        {
                            id: "jz_fusion",
                            name: "Jazz Fusion",
                        },
                        {
                            id: "jz_cool",
                            name: "Cool Jazz",
                        },
                        {
                            id: "jz_free",
                            name: "Free Jazz",
                        },
                        {
                            id: "jz_smooth",
                            name: "Smooth Jazz",
                        },
                    ],
                },
                {
                    id: "blues",
                    name: "Blues",
                    description: "Blues and related styles",
                    subOptions: [
                        {
                            id: "blues_electric",
                            name: "Electric Blues",
                        },
                        {
                            id: "blues_main",
                            name: "Blues",
                        },
                        {
                            id: "blues_country",
                            name: "Country Blues",
                        },
                        {
                            id: "blues_chicago",
                            name: "Chicago Blues",
                        },
                        {
                            id: "blues_rhythm",
                            name: "Rhythm & Blues",
                        },
                        {
                            id: "blues_delta",
                            name: "Delta Blues",
                        },
                    ],
                },
                {
                    id: "dance",
                    name: "Electronic / Dance",
                    description: "Electronic Dance Music",
                    subOptions: [
                        {
                            id: "edm_breakbeat",
                            name: "Breakbeat",
                        },
                        {
                            id: "edm_electro",
                            name: "Electro",
                        },
                        {
                            id: "edm_dubstep",
                            name: "Dubstep",
                        },
                        {
                            id: "edm_main",
                            name: "Dance",
                        },
                        {
                            id: "edm_bigroom",
                            name: "Big Room",
                        },
                        {
                            id: "edm_futbass",
                            name: "Future Bass",
                        },
                        {
                            id: "edm_edm",
                            name: "EDM",
                        },
                        {
                            id: "edm_electroclash",
                            name: "Electroclash",
                        },
                        {
                            id: "edm_drumstep",
                            name: "Drum Step",
                        },
                    ],
                },
                {
                    id: "house",
                    name: "House",
                    description: "Classic and modern house",
                    subOptions: [
                        {
                            id: "hs_progressive",
                            name: "Progressive House",
                        },
                        {
                            id: "hs_tribal",
                            name: "Tribal House",
                        },
                        {
                            id: "hs_main",
                            name: "House",
                        },
                        {
                            id: "hs_afro",
                            name: "Afro House",
                        },
                        {
                            id: "hs_deep",
                            name: "Deep House",
                        },
                        {
                            id: "hs_ukgarage",
                            name: "UK Garage",
                        },
                        {
                            id: "hs_tech",
                            name: "Tech House",
                        },
                        {
                            id: "hs_future",
                            name: "Future House",
                        },
                    ],
                },
                {
                    id: "techno",
                    name: "Techno",
                    description: "Industrial and hypnotic techno",
                    subOptions: [
                        {
                            id: "tch_minimal",
                            name: "Minimal Techno",
                        },
                        {
                            id: "tch_main",
                            name: "Techno",
                        },
                        {
                            id: "tch_detroit",
                            name: "Detroit Techno",
                        },
                        {
                            id: "tch_hard",
                            name: "Hard Techno",
                        },
                        {
                            id: "tch_industrial",
                            name: "Industrial Techno",
                        },
                        {
                            id: "tch_melodic",
                            name: "Melodic Techno",
                        },
                        {
                            id: "tch_acid",
                            name: "Acid Techno",
                        },
                    ],
                },
                {
                    id: "trance",
                    name: "Trance",
                    description: "Uplifting and emotional trance",
                    subOptions: [
                        {
                            id: "trn_goa",
                            name: "Goa Trance",
                        },
                        {
                            id: "trn_uplifting",
                            name: "Uplifting Trance",
                        },
                        {
                            id: "trn_main",
                            name: "Trance",
                        },
                        {
                            id: "trn_vocal",
                            name: "Vocal Trance",
                        },
                        {
                            id: "trn_psy",
                            name: "Psytrance",
                        },
                        {
                            id: "trn_darkpsy",
                            name: "Dark Psy",
                        },
                        {
                            id: "trn_progressive",
                            name: "Progressive Trance",
                        },
                    ],
                },
                {
                    id: "dnb",
                    name: "Drum & Bass",
                    description: "Fast drum and bass",
                    subOptions: [
                        {
                            id: "dnb_jumpup",
                            name: "Jump Up",
                        },
                        {
                            id: "dnb_main",
                            name: "Drum & Bass",
                        },
                        {
                            id: "dnb_halftime",
                            name: "Halftime",
                        },
                        {
                            id: "dnb_neurofunk",
                            name: "Neurofunk",
                        },
                        {
                            id: "dnb_footwork",
                            name: "Footwork",
                        },
                        {
                            id: "dnb_liquid",
                            name: "Liquid DnB",
                        },
                        {
                            id: "dnb_jungle",
                            name: "Jungle",
                        },
                    ],
                },
                {
                    id: "ambient",
                    name: "Ambient / IDM",
                    description: "Ambient, experimental and atmospheric",
                    subOptions: [
                        {
                            id: "amb_noise",
                            name: "Noise",
                        },
                        {
                            id: "amb_idm",
                            name: "IDM",
                        },
                        {
                            id: "amb_main",
                            name: "Ambient",
                        },
                        {
                            id: "amb_glitch",
                            name: "Glitch",
                        },
                        {
                            id: "amb_space",
                            name: "Space Ambient",
                        },
                        {
                            id: "amb_drone",
                            name: "Drone",
                        },
                        {
                            id: "amb_experimental",
                            name: "Experimental Electronic",
                        },
                        {
                            id: "amb_dark",
                            name: "Dark Ambient",
                        },
                    ],
                },
                {
                    id: "lofi-chill",
                    name: "Lo-Fi / Chill",
                    description: "Relaxed and downtempo vibes",
                    subOptions: [
                        {
                            id: "chill_chillwave",
                            name: "Chillwave",
                        },
                        {
                            id: "chill_main",
                            name: "Lo-Fi",
                        },
                        {
                            id: "chill_downtempo",
                            name: "Downtempo",
                        },
                        {
                            id: "chill_step",
                            name: "Chillstep",
                        },
                        {
                            id: "chill_out",
                            name: "Chillout",
                        },
                        {
                            id: "chill_triphop",
                            name: "Trip-Hop",
                        },
                    ],
                },
                {
                    id: "classical",
                    name: "Classical",
                    description: "Classical and academic music",
                    subOptions: [
                        {
                            id: "cls_chamber",
                            name: "Chamber Music",
                        },
                        {
                            id: "cls_romantic",
                            name: "Romantic Era",
                        },
                        {
                            id: "cls_main",
                            name: "Classical",
                        },
                        {
                            id: "cls_minimalism",
                            name: "Minimalism",
                        },
                        {
                            id: "cls_neoclassical",
                            name: "Neoclassical",
                        },
                        {
                            id: "cls_contemporary",
                            name: "Contemporary Classical",
                        },
                        {
                            id: "cls_baroque",
                            name: "Baroque",
                        },
                    ],
                },
                {
                    id: "opera",
                    name: "Opera / Theatrical",
                    description: "Opera, musical theatre and vocal performance",
                    subOptions: [
                        {
                            id: "opr_chanson",
                            name: "Chanson",
                        },
                        {
                            id: "opr_main",
                            name: "Opera",
                        },
                        {
                            id: "opr_cabaret",
                            name: "Cabaret",
                        },
                        {
                            id: "opr_operatic_pop",
                            name: "Operatic Pop",
                        },
                        {
                            id: "opr_aria",
                            name: "Aria",
                        },
                        {
                            id: "opr_musical",
                            name: "Musical Theatre",
                        },
                    ],
                },
                {
                    id: "cinematic",
                    name: "Cinematic / Soundtrack",
                    description: "Film, TV and game music",
                    subOptions: [
                        {
                            id: "cin_trailer",
                            name: "Trailer Music",
                        },
                        {
                            id: "cin_main",
                            name: "Cinematic",
                        },
                        {
                            id: "cin_epic",
                            name: "Epic Orchestral",
                        },
                        {
                            id: "cin_vgame",
                            name: "Video Game OST",
                        },
                        {
                            id: "cin_dark",
                            name: "Dark Cinematic",
                        },
                        {
                            id: "cin_orchestral",
                            name: "Orchestral",
                        },
                        {
                            id: "cin_tv",
                            name: "TV Soundtrack",
                        },
                    ],
                },
                {
                    id: "reggae",
                    name: "Reggae",
                    description: "Reggae and Caribbean rhythms",
                    subOptions: [
                        {
                            id: "reg_dancehall",
                            name: "Dancehall",
                        },
                        {
                            id: "reg_main",
                            name: "Reggae",
                        },
                        {
                            id: "reg_roots",
                            name: "Roots Reggae",
                        },
                        {
                            id: "reg_ska",
                            name: "Ska",
                        },
                        {
                            id: "reg_dub",
                            name: "Dub",
                        },
                        {
                            id: "reg_rocksteady",
                            name: "Rock Steady",
                        },
                    ],
                },
                {
                    id: "latin",
                    name: "Latin",
                    description: "Latin and Caribbean music",
                    subOptions: [
                        {
                            id: "lat_tango",
                            name: "Tango",
                        },
                        {
                            id: "lat_cumbia",
                            name: "Cumbia",
                        },
                        {
                            id: "lat_pop",
                            name: "Latin Pop",
                        },
                        {
                            id: "lat_reggaeton",
                            name: "Reggaeton",
                        },
                        {
                            id: "lat_mariachi",
                            name: "Mariachi",
                        },
                        {
                            id: "lat_bossa",
                            name: "Bossa Nova",
                        },
                        {
                            id: "lat_bachata",
                            name: "Bachata",
                        },
                        {
                            id: "lat_flamenco",
                            name: "Flamenco",
                        },
                        {
                            id: "lat_salsa",
                            name: "Salsa",
                        },
                        {
                            id: "lat_samba",
                            name: "Samba",
                        },
                    ],
                },
                {
                    id: "folk-country",
                    name: "Folk / Country",
                    description: "Folk, country and acoustic traditions",
                    subOptions: [
                        {
                            id: "flk_bluegrass",
                            name: "Bluegrass",
                        },
                        {
                            id: "flk_main",
                            name: "Folk",
                        },
                        {
                            id: "flk_countrypop",
                            name: "Country Pop",
                        },
                        {
                            id: "flk_indie",
                            name: "Indie Folk",
                        },
                        {
                            id: "flk_celtic",
                            name: "Celtic",
                        },
                        {
                            id: "flk_country",
                            name: "Country",
                        },
                        {
                            id: "flk_americana",
                            name: "Americana",
                        },
                        {
                            id: "flk_singersongwriter",
                            name: "Singer-Songwriter",
                        },
                    ],
                },
                {
                    id: "world",
                    name: "World Music",
                    description: "Global and ethnic music",
                    subOptions: [
                        {
                            id: "wld_afropop",
                            name: "Afropop",
                        },
                        {
                            id: "wld_gamelan",
                            name: "Gamelan",
                        },
                        {
                            id: "wld_celtic",
                            name: "Celtic Folk",
                        },
                        {
                            id: "wld_arabic",
                            name: "Arabic Music",
                        },
                        {
                            id: "wld_afrobeat",
                            name: "Afrobeat",
                        },
                        {
                            id: "wld_main",
                            name: "World Music",
                        },
                        {
                            id: "wld_indian",
                            name: "Indian Classical",
                        },
                    ],
                },
            ];

            // Genre key aliases for UI compatibility
            const GENRE_KEY_ALIASES = {
                folk: "folk-country",
                country: "folk-country",
                rnb: "rnb-soul",
                hiphop: "hip-hop",
                afrobeats: "world",
                salsa: "latin",
                ska: "reggae",
                cumbia: "latin",
                gospel: "rnb-soul",
                electronic: "dance",
                ambient: "ambient",
                lofi: "lofi-chill",
                classical: "classical",
                cinematic: "cinematic",
            };

            function normalizeGenreKey(genreKey) {
                return GENRE_KEY_ALIASES[genreKey] || genreKey;
            }

            // Helper functions for genre metadata
            function getGenreById(genreId) {
                const normalizedId = normalizeGenreKey(genreId);
                return GENRE_METADATA.find((g) => g.id === normalizedId);
            }

            function getSubGenresForGenre(genreId) {
                const genre = getGenreById(genreId);
                return genre ? genre.subOptions : [];
            }

            function findGenreBySubgenreName(subgenreName) {
                const normalized = subgenreName.toLowerCase().trim();
                for (const genre of GENRE_METADATA) {
                    const matchingSub = genre.subOptions.find((sub) => sub.name.toLowerCase() === normalized);
                    if (matchingSub) {
                        return { genre: genre, subgenre: matchingSub };
                    }
                }
                return null;
            }

            function getAllSubGenreNames() {
                const names = [];
                GENRE_METADATA.forEach((genre) => {
                    genre.subOptions.forEach((sub) => {
                        names.push(sub.name);
                    });
                });
                return names;
            }

            function getGenreOptionsForAnalyzer() {
                return GENRE_METADATA.map((g) => g.id).join("|");
            }

            function getAllGenreAndSubGenreNames() {
                const names = [];
                GENRE_METADATA.forEach((genre) => {
                    names.push(genre.name);
                    genre.subOptions.forEach((sub) => {
                        names.push(sub.name);
                    });
                });
                return names.join(", ");
            }

            // ========================================================================
            // Hierarchical Genre Selection State and Functions
            // ========================================================================
            let selectedGenres = []; // Array of {mainGenre, subGenre, mainId, subId}
            let currentMainGenreSelection = null;
            let currentSubGenreSelection = null;

            // Initialize main genre tags from GENRE_METADATA
            function initializeGenreSelector() {
                const mainTagsContainer = document.getElementById("genre-main-tags");
                mainTagsContainer.innerHTML = "";

                GENRE_METADATA.forEach((genre, index) => {
                    const tag = document.createElement("div");
                    tag.className = "tag";
                    tag.textContent = genre.name;
                    tag.dataset.genreId = genre.id;
                    tag.dataset.genreName = genre.name;

                    // Add color classes for variety
                    const colorClass = ["", "g2", "g3", "g4", "g5", "g6"][index % 6];
                    if (colorClass) tag.classList.add(colorClass);

                    tag.addEventListener("click", () => selectMainGenre(genre));
                    mainTagsContainer.appendChild(tag);
                });

                // Don't auto-select any genre - let user choose
                updateSelectedGenresDisplay();
            }

            function selectMainGenre(genre) {
                const isSameMainGenre = currentMainGenreSelection && currentMainGenreSelection.id === genre.id;
                if (isSameMainGenre) {
                    cancelGenreSelection();
                    return;
                }

                currentMainGenreSelection = genre;
                currentSubGenreSelection = null;

                // Update UI
                document.querySelectorAll("#genre-main-tags .tag").forEach((t) => t.classList.remove("active"));
                const activeTag = document.querySelector(`#genre-main-tags .tag[data-genre-id=\"${genre.id}\"]`);
                if (activeTag) activeTag.classList.add("active");

                // Show sub-genre section
                document.getElementById("subgenre-section").style.display = "block";
                document.getElementById("current-main-genre-name").textContent = genre.name;

                // Populate sub-genres
                const subTagsContainer = document.getElementById("genre-sub-tags");
                subTagsContainer.innerHTML = "";

                if (genre.subOptions && genre.subOptions.length > 0) {
                    genre.subOptions.forEach((subGenre) => {
                        const tag = document.createElement("div");
                        tag.className = "tag multi";
                        tag.textContent = subGenre.name;
                        tag.dataset.subgenreId = subGenre.id;
                        tag.dataset.subgenreName = subGenre.name;
                        tag.addEventListener("click", () => selectSubGenre(subGenre));
                        subTagsContainer.appendChild(tag);
                    });
                } else {
                    subTagsContainer.innerHTML = '<div style=\"font-size: 12px; color: var(--text-muted); padding: 8px;\">No sub-genres available for this genre</div>';
                }

                // Disable add button until sub-genre selected
                document.getElementById("add-genre-btn").disabled = true;
            }

            function selectSubGenre(subGenre) {
                const isSameSubGenre = currentSubGenreSelection && currentSubGenreSelection.id === subGenre.id;
                if (isSameSubGenre) {
                    currentSubGenreSelection = null;
                    document.querySelectorAll("#genre-sub-tags .tag").forEach((t) => t.classList.remove("active"));
                    document.getElementById("add-genre-btn").disabled = true;
                    return;
                }

                currentSubGenreSelection = subGenre;

                // Update UI
                document.querySelectorAll("#genre-sub-tags .tag").forEach((t) => t.classList.remove("active"));
                const activeTag = document.querySelector(`#genre-sub-tags .tag[data-subgenre-id=\"${subGenre.id}\"]`);
                if (activeTag) activeTag.classList.add("active");

                // Enable add button
                document.getElementById("add-genre-btn").disabled = false;
            }

            function addSelectedGenre() {
                if (!currentMainGenreSelection || !currentSubGenreSelection) return;

                // Check if this combination already exists
                const exists = selectedGenres.some((g) => g.mainId === currentMainGenreSelection.id && g.subId === currentSubGenreSelection.id);

                if (!exists) {
                    addGenreToSelection(currentMainGenreSelection, currentSubGenreSelection);
                }

                // Reset selection
                cancelGenreSelection();
            }

            function addGenreToSelection(mainGenre, subGenre) {
                selectedGenres.push({
                    mainGenre: mainGenre.name,
                    subGenre: subGenre.name,
                    mainId: mainGenre.id,
                    subId: subGenre.id,
                });

                updateSelectedGenresDisplay();
                updateCurrentGenreKey();
            }

            function removeSelectedGenre(index) {
                selectedGenres.splice(index, 1);
                updateSelectedGenresDisplay();
                updateCurrentGenreKey();
            }

            function updateSelectedGenresDisplay() {
                const displayContainer = document.getElementById("selected-genres-display");

                if (selectedGenres.length === 0) {
                    displayContainer.style.display = "none";
                    displayContainer.innerHTML = "";
                    return;
                }

                displayContainer.style.display = "flex";
                displayContainer.innerHTML = "";

                selectedGenres.forEach((genre, index) => {
                    const chip = document.createElement("div");
                    chip.className = "selected-genre-chip";
                    chip.innerHTML = `
                        <span class=\"genre-main\">${genre.mainGenre}</span>
                        <span style=\"opacity: 0.5;\">•</span>
                        <span class=\"genre-sub\">${genre.subGenre}</span>
                        <span class=\"remove-chip\" onclick=\"removeSelectedGenre(${index})\">×</span>
                    `;
                    displayContainer.appendChild(chip);
                });
            }

            function updateCurrentGenreKey() {
                // Update currentGenreKey to first selected genre's main ID for structure compatibility
                if (selectedGenres.length > 0) {
                    const normalizedKey = normalizeGenreKey(selectedGenres[0].mainId);
                    currentGenreKey = normalizedKey;
                    // Only build structure list if the element exists (not during early init)
                    if (document.getElementById("structure-list")) {
                        buildStructureList(currentGenreKey);
                    }
                } else {
                    // No genres selected - use default Rock for structure list
                    currentGenreKey = "rock";
                    // Only build structure list if the element exists (not during early init)
                    if (document.getElementById("structure-list")) {
                        buildStructureList(currentGenreKey);
                    }
                }
            }

            function cancelGenreSelection() {
                currentMainGenreSelection = null;
                currentSubGenreSelection = null;

                // Hide sub-genre section
                document.getElementById("subgenre-section").style.display = "none";

                // Clear active states
                document.querySelectorAll("#genre-main-tags .tag").forEach((t) => t.classList.remove("active"));
                document.querySelectorAll("#genre-sub-tags .tag").forEach((t) => t.classList.remove("active"));
            }

            function showCustomGenreInput() {
                document.getElementById("genre-custom-input-row").style.display = "flex";
                document.getElementById("genre-custom-input").focus();
            }

            function hideCustomGenreInput() {
                document.getElementById("genre-custom-input-row").style.display = "none";
                document.getElementById("genre-custom-input").value = "";
            }

            function confirmCustomGenre() {
                const input = document.getElementById("genre-custom-input");
                const value = input.value.trim();

                if (value) {
                    selectedGenres.push({
                        mainGenre: "Custom",
                        subGenre: value,
                        mainId: "custom",
                        subId: "custom_" + Date.now(),
                    });

                    updateSelectedGenresDisplay();
                    updateCurrentGenreKey();
                    hideCustomGenreInput();
                }
            }

            function getSelectedGenreLabel() {
                if (selectedGenres.length === 0) return "Not specified";

                // Return formatted string of all selected genres
                return selectedGenres.map((g) => `${g.mainGenre}: ${g.subGenre}`).join(" + ");
            }

            // ========================================================================
            // Genre Structures
            // Defines preset structures for different musical genres
            // ========================================================================
            const GENRE_STRUCTURES = {
                rock: [
                    { name: "Standard Rock", tag: "Classic", flow: "Intro -> V -> Ch -> V -> Ch -> Bridge -> Ch -> Outro", desc: "Two verses build tension before the bridge breaks it open." },
                    { name: "Double Chorus", tag: "Arena", flow: "Intro -> V -> PCh -> Ch -> Ch -> V -> PCh -> Ch -> Bridge -> Ch", desc: "Two consecutive choruses drive the hook home." },
                    { name: "Extended Outro Jam", tag: "Classic Rock", flow: "Intro -> V -> Ch -> V -> Ch -> Bridge -> Ch -> Outro Jam", desc: "Song climaxes and fades over an extended instrumental." },
                    { name: "Riff-Led", tag: "Hard Rock", flow: "Riff Intro -> V -> Ch -> Riff -> V -> Ch -> Solo -> Ch x2 -> Fade", desc: "Guitar riff anchors every section. Solo sits in place of bridge." },
                    { name: "No Bridge", tag: "Punk / Garage", flow: "Intro -> V -> Ch -> V -> Ch -> Ch -> Outro", desc: "Fast, lean, direct. No bridge - just raw repetition of the hook." },
                    { name: "Progressive Build", tag: "Prog Rock", flow: "Intro -> V1 -> V2 -> Instrumental -> V3 -> Climax -> Coda", desc: "No traditional chorus; the song builds through dynamic shifts." },
                    { name: "Pre-Chorus Builder", tag: "Modern Rock", flow: "Intro -> V -> PCh -> Ch -> V -> PCh -> Ch -> Bridge -> PCh -> Ch", desc: "Pre-chorus acts as a tension-building runway into every chorus." },
                    { name: "Anthemic Single", tag: "Radio Rock", flow: "Intro -> V -> PCh -> Big Ch -> Post-Ch -> V -> PCh -> Big Ch -> Bridge -> Final Ch", desc: "Built for maximum impact with a post-chorus hook." },
                    { name: "Slow Burn", tag: "Classic Rock", flow: "Slow Intro -> Long V1 -> Ch -> Long V2 -> Ch -> Extended Solo -> Ch -> Fade", desc: "Long verses let lyrics breathe before the payoff." },
                    { name: "Breakdown & Build", tag: "Alt Rock", flow: "Intro -> V -> Ch -> V -> Ch -> Breakdown -> Build -> Ch x2", desc: "Mid-song breakdown strips everything back before an explosive build." },
                    { name: "Circular / Through-Composed", tag: "Art Rock", flow: "Theme A -> Theme B -> Theme C -> A' -> B' -> Coda", desc: "Themes evolve and return transformed." },
                ],
                metal: [
                    { name: "Standard Metal", tag: "Classic", flow: "Intro -> V -> Ch -> V -> Ch -> Solo -> Bridge -> Ch -> Outro", desc: "Guitar solo replaces or augments the bridge." },
                    { name: "Thrash Assault", tag: "Thrash", flow: "Fast Intro -> V -> Ch -> V -> Ch -> Breakdown -> Solo -> Thrash Outro", desc: "Relentless tempo with a mid-song breakdown before an explosive solo." },
                    { name: "Epic / Doom", tag: "Doom", flow: "Slow Intro -> Long V1 -> Crushing Ch -> V2 -> Ch -> Instrumental -> Outro", desc: "Extended sections, slow tempos, massive dynamics." },
                    { name: "Progressive Metal Suite", tag: "Prog Metal", flow: "Prelude -> Part I -> Part II -> Interlude -> Part III -> Climax -> Coda", desc: "Through-composed movements. Time signature changes throughout." },
                    { name: "Power Metal Anthem", tag: "Power Metal", flow: "Orchestral Intro -> V -> PCh -> Epic Ch -> V -> PCh -> Ch -> Solo -> Ch x2 -> Outro", desc: "Cinematic intro, soaring pre-chorus, and a massive double chorus finale." },
                    { name: "Groove Metal Chug", tag: "Groove Metal", flow: "Groove Riff -> V -> Ch -> Groove Riff -> V -> Ch -> Breakdown -> Ch", desc: "Groove riff returns between sections." },
                    { name: "Ballad to Devastation", tag: "Metal Ballad", flow: "Clean Intro -> Soft V -> Build Ch -> Soft V -> Heavy Ch -> Solo -> Full Heavy Outro", desc: "Opens clean and vulnerable, explodes into full metal for the climax." },
                    { name: "Speed Run", tag: "Speed Metal", flow: "Intro -> V -> Ch -> V -> Ch -> Solo -> Ch -> Outro", desc: "Compressed, high-velocity. Everything stripped to maximum impact." },
                    { name: "Concept Track", tag: "Prog / Symphonic", flow: "Overture -> Narrative V1 -> Instrumental Bridge -> V2 -> Climax -> Epilogue", desc: "Tells a complete story. Orchestral or synth elements weave throughout." },
                    { name: "Black Metal Torrent", tag: "Black Metal", flow: "Tremolo Intro -> V -> Atmospheric Break -> V -> Ch -> Outro Ambience", desc: "Relentless tremolo picking with an atmospheric mid-section break." },
                ],
                folk: [
                    { name: "Traditional Ballad", tag: "Traditional", flow: "V1 -> V2 -> V3 -> V4 (story unfolds, no chorus)", desc: "Pure verse-driven storytelling." },
                    { name: "Verse-Chorus Folk", tag: "Modern Folk", flow: "V -> Ch -> V -> Ch -> Bridge -> Ch -> Outro", desc: "Story verses anchor a singalong chorus." },
                    { name: "AABA", tag: "Classic", flow: "A section -> A section -> B (bridge) -> A section", desc: "32-bar form beloved in early folk, country, and pop songwriting." },
                    { name: "Cumulative / Additive", tag: "Storytelling", flow: "V1 -> V1+2 -> V1+2+3 (each verse builds on the last)", desc: "Each verse adds a new layer - the song grows richer with every repeat." },
                    { name: "Through-Composed", tag: "Folk Art", flow: "V1 -> V2 -> V3 -> V4 (each verse has different melody)", desc: "No repeated music - the melody evolves with the story." },
                    { name: "Talking Blues", tag: "Talking Blues", flow: "Spoken V -> Sung Ch -> Spoken V -> Sung Ch -> Tag", desc: "Verses spoken rhythmically; chorus sung." },
                    { name: "Question & Answer", tag: "Dialogue", flow: "Question V -> Answer V -> Question V -> Answer V -> Resolved Ch -> Outro", desc: "Song structured as a dialogue between two perspectives." },
                    { name: "Protest Song", tag: "Topical", flow: "Context V -> Verse -> Hook/Refrain -> Verse -> Hook -> Bridge -> Final Hook", desc: "Each verse builds the argument; the hook is the rallying cry." },
                    { name: "Modal Drone Form", tag: "Celtic", flow: "Drone Intro -> V -> Instrumental Break -> V -> V -> Drone Outro", desc: "Built over a sustained modal drone." },
                    { name: "Call & Response", tag: "Appalachian", flow: "Call V -> Response V -> Call V -> Response V -> Outro", desc: "Two voices or melodic lines answer each other throughout." },
                    { name: "Child Ballad Form", tag: "Traditional", flow: "V1 -> V2 -> V3 -> V4 -> V5 (dramatic arc, no chorus)", desc: "Long narrative form from the English/Scottish ballad tradition." },
                ],
                country: [
                    { name: "Classic Country", tag: "Traditional", flow: "Intro -> V -> Ch -> V -> Ch -> Bridge -> Ch -> Outro", desc: "Honky-tonk backbone. Story in verses, emotion in the chorus." },
                    { name: "Outlaw Story Song", tag: "Outlaw", flow: "Intro -> V1 (setup) -> V2 (conflict) -> Ch -> V3 (resolution) -> Ch -> Tag", desc: "Narrative-heavy verses tell a complete three-act story." },
                    { name: "AABA Country", tag: "Classic", flow: "A -> A -> B (bridge) -> A -> Tag", desc: "Compact 32-bar form - traditional country and honky-tonk staple." },
                    { name: "Cry-in-Your-Beer Ballad", tag: "Heartbreak", flow: "Slow Intro -> V -> Ch -> V -> Ch -> Breakdown -> Final Ch", desc: "Slow, mournful ballad with a stripped breakdown." },
                    { name: "Drinking Song / Anthem", tag: "Party", flow: "Intro Riff -> V -> Big Ch -> V -> Big Ch -> Ch Repeat x2 -> Outro", desc: "Up-tempo, singalong chorus repeated for maximum crowd participation." },
                    { name: "Bro-Country Drive", tag: "Modern Country", flow: "Intro -> V -> PCh -> Ch -> Post-Ch -> V -> PCh -> Ch -> Bridge -> Ch", desc: "High-production modern form with a post-chorus hook." },
                    { name: "Western Swing", tag: "Western Swing", flow: "Intro -> V -> Instrumental Break -> V -> Ch -> Fiddle Solo -> Ch -> Outro", desc: "Fiddle and steel guitar breaks are structural pillars." },
                    { name: "Bluegrass Form", tag: "Bluegrass", flow: "Intro -> V -> Ch -> Banjo Break -> V -> Ch -> Fiddle Break -> Ch -> Outro", desc: "Instrumental solos rotate through banjo, fiddle, mandolin between vocal sections." },
                    { name: "Duet / Dialogue", tag: "Duet", flow: "V (voice 1) -> V (voice 2) -> Duet Ch -> V (both) -> Bridge -> Duet Ch", desc: "Two voices alternate verses before joining for the chorus." },
                    { name: "Gospel-Country", tag: "Gospel Country", flow: "V -> Testimony Ch -> V -> Ch -> Call & Response Bridge -> Final Ch", desc: "Bridge becomes a call-and-response communal moment." },
                    { name: "Crossover Pop-Country", tag: "Crossover", flow: "Intro -> V -> PCh -> Ch -> Post-Ch Drop -> V -> PCh -> Ch -> Bridge -> Final Ch", desc: "Nashville meets pop production." },
                ],
                jazz: [
                    { name: "32-Bar AABA", tag: "Standard", flow: "A (8) -> A (8) -> B / Bridge (8) -> A (8)", desc: "The most common jazz standard form." },
                    { name: "32-Bar ABAC", tag: "Standard", flow: "A (8) -> B (8) -> A (8) -> C (8)", desc: "Variation on the standard form with a different concluding section." },
                    { name: "12-Bar Jazz Blues", tag: "Jazz Blues", flow: "I (4) -> IV (2) -> I (2) -> V (1) -> IV (1) -> I (2) [repeated]", desc: "Blues form reharmonised with jazz substitutions." },
                    { name: "Through-Composed Head", tag: "Modern Jazz", flow: "Head (full composition) -> Solos (free length) -> Head out", desc: "No repeated sections in the head." },
                    { name: "Modal / Open Form", tag: "Modal Jazz", flow: "Vamp -> Melody statement -> Open modal solos -> Melody return -> Free Outro", desc: "Built over static modes. Miles Davis territory." },
                    { name: "Rhythm Changes", tag: "Bebop", flow: "A (I-VI-II-V) -> A -> B (III7-VI7-II7-V7) -> A [repeated]", desc: "Bebop cornerstone based on I Got Rhythm." },
                    { name: "Jazz Waltz", tag: "3/4", flow: "Intro -> Head (A-A-B-A) -> Solos -> Head Out -> Tag", desc: "Same AABA form but in 3/4." },
                    { name: "Ballad Form", tag: "Ballad", flow: "Rubato Intro -> Head (slow) -> Solo (in time) -> Head (rubato) -> Tag", desc: "Opens and closes without strict tempo." },
                    { name: "Bossa Nova Form", tag: "Bossa Nova", flow: "Intro -> A section -> B section -> A section -> Solo -> A -> Fade", desc: "Brazilian-jazz fusion. Gentle, interlocking rhythms." },
                    { name: "Suite Form", tag: "Extended", flow: "Movement I -> Movement II -> Movement III -> Recapitulation", desc: "Multi-movement composition with contrasting sections." },
                ],
                blues: [
                    { name: "12-Bar Blues", tag: "Standard", flow: "I (4) -> IV (2) -> I (2) -> V (1) -> IV (1) -> I (2) [x3+]", desc: "The foundation of all blues. Three chords, twelve bars, infinite expression." },
                    { name: "8-Bar Blues", tag: "Compact", flow: "I (2) -> V (2) -> IV (2) -> I (2) [repeated]", desc: "Shorter, more urgent form." },
                    { name: "16-Bar Blues", tag: "Extended", flow: "I (4) -> IV (4) -> I (4) -> V-IV-I (4) [repeated]", desc: "Extended form giving extra space for lyrical development." },
                    { name: "AAB Lyric Form", tag: "Traditional", flow: "A line (I-IV-I) -> A line repeat -> B response line (V-IV-I)", desc: "Classic Delta blues: state it, repeat it, resolve it." },
                    { name: "Slow Blues", tag: "Slow Blues", flow: "Slow 12-bar x4 with extended turnaround and call-response guitar", desc: "Half the tempo, double the feeling." },
                    { name: "Chicago Blues Form", tag: "Chicago", flow: "Intro Riff -> 12-bar V x2 -> Harmonica Solo -> 12-bar V -> Outro Riff", desc: "Band-driven, amplified. Harmonica solo is a structural anchor." },
                    { name: "Delta / Acoustic Form", tag: "Delta Blues", flow: "Verse (AAB) -> Bottleneck Break -> Verse (AAB) -> Verse -> Tag", desc: "Sparse and raw. Bottleneck slide break sits between vocal sections." },
                    { name: "Minor Blues", tag: "Minor", flow: "Im (4) -> IVm (2) -> Im (2) -> V7 (1) -> IVm (1) -> Im (2)", desc: "The 12-bar in a minor key." },
                    { name: "Texas Shuffle", tag: "Texas Blues", flow: "Shuffle Intro -> 12-bar V x2 -> Guitar Solo -> 12-bar V -> Turnaround -> Outro", desc: "Dotted shuffle rhythm drives everything." },
                    { name: "Boogie Blues", tag: "Boogie", flow: "Boogie Intro -> 12-bar V -> 12-bar V -> Piano/Guitar Solo -> 12-bar V -> Outro", desc: "Walking bass or boogie pattern drives relentless forward momentum." },
                ],
                rnb: [
                    { name: "Classic R&B", tag: "Classic", flow: "Intro -> V -> Ch -> V -> Ch -> Bridge -> Ch -> Outro", desc: "Smooth and dependable." },
                    { name: "Groove Vamp", tag: "Neo-Soul", flow: "Vamp Intro -> V -> Hook -> Vamp -> V -> Hook -> Breakdown -> Hook -> Outro Vamp", desc: "Built on a repeating groove vamp." },
                    { name: "Contemporary R&B", tag: "Modern", flow: "Intro -> V -> PCh -> Ch -> Post-Ch -> V -> PCh -> Ch -> Bridge -> Final Ch", desc: "Post-chorus hook extends the energy after the main chorus drop." },
                    { name: "Slow Jam", tag: "Slow Jam", flow: "Slow Intro -> V -> Ch -> V -> Ch -> Spoken Bridge -> Final Ch", desc: "Intimate and unhurried." },
                    { name: "Neo-Soul Odyssey", tag: "Neo-Soul", flow: "Intro -> V -> Ch -> Instrumental Interlude -> V -> Ch -> Extended Outro", desc: "Long instrumental interludes are a feature, not filler." },
                    { name: "Trap Soul", tag: "Trap Soul", flow: "Intro (808s) -> V (sung/rapped) -> Hook -> V -> Hook -> Bridge -> Hook x2", desc: "Trap production meets R&B melody." },
                    { name: "Throwback Soul", tag: "Motown / Stax", flow: "Punchy Intro -> V -> Ch -> V -> Ch -> Modulation Bridge -> Final Ch (new key)", desc: "Key modulation before the final chorus - a classic Motown/Stax device." },
                    { name: "Call & Response", tag: "Soul", flow: "V (lead) -> V (response) -> Ch -> V (lead) -> V (response) -> Bridge -> Ch", desc: "Lead vocal sets up a phrase; background vocals respond." },
                ],
                hiphop: [
                    { name: "Classic Rap Song", tag: "Classic", flow: "Intro -> V1 -> Hook -> V2 -> Hook -> V3 -> Hook -> Outro", desc: "Three verses and a hook. The foundational hip-hop structure." },
                    { name: "Two-Verse Banger", tag: "Modern", flow: "Intro -> V1 -> Hook -> V2 -> Hook -> Bridge/Outro", desc: "Leaner two-verse format." },
                    { name: "Trap Anthem", tag: "Trap", flow: "Intro (ad-libs) -> Hook -> V -> Hook -> V -> Hook -> Bridge Ad-libs -> Hook", desc: "Hook leads the song." },
                    { name: "Boom-Bap Cipher", tag: "Boom-Bap", flow: "Beat Intro -> V1 (16 bars) -> V2 (16 bars) -> V3 (16 bars) -> Outro", desc: "No hook - pure MC bars." },
                    { name: "Narrative / Storytelling", tag: "Storytelling", flow: "Scene-setting Intro -> V1 (act 1) -> V2 (act 2) -> V3 (climax) -> Outro", desc: "No hook - three verses tell a complete story." },
                    { name: "R&B / Rap Fusion", tag: "Melodic Rap", flow: "Intro -> Sung Hook -> Rap V -> Sung Hook -> Rap V -> Bridge (sung) -> Final Hook", desc: "Sung hooks frame rap verses." },
                    { name: "Loop-Based Groove", tag: "Lo-Fi / Jazz Rap", flow: "Loop Intro -> V1 -> Loop Break -> V2 -> Loop Break -> V3 -> Outro Loop", desc: "Beat loops are structural pillars." },
                    { name: "West Coast G-Funk", tag: "G-Funk", flow: "Synth Intro -> V -> Sung Hook -> V -> Hook -> Talk-box Bridge -> Hook -> Fade", desc: "Melodic synth hooks, laid-back verses." },
                ],
                gospel: [
                    { name: "Traditional Hymn", tag: "Traditional", flow: "V1 -> V2 -> V3 -> V4 (narrative unfolding, chorus as refrain)", desc: "Classic hymn form." },
                    { name: "Contemporary Gospel", tag: "Contemporary", flow: "Intro -> V -> Ch -> V -> Ch -> Bridge (vamp) -> Ch -> Outro", desc: "Modern gospel with a vamp bridge." },
                    { name: "Praise & Worship", tag: "P&W", flow: "Intro Worship -> V -> Ch -> Ch -> Bridge (spontaneous) -> Ch -> Outro", desc: "Bridge opens into spontaneous worship." },
                    { name: "Call & Response Shout", tag: "Shout", flow: "Leader V -> Choir Response -> Leader V -> Choir Response -> Vamp -> Shout Outro", desc: "Leader and choir exchange throughout." },
                    { name: "Mass Choir Anthem", tag: "Mass Choir", flow: "Dramatic Intro -> V -> Big Ch -> V -> Big Ch -> Modulation Bridge -> Final Ch (new key)", desc: "Key modulation before the final chorus." },
                    { name: "Testimony Song", tag: "Testimony", flow: "Testimony V -> Ch (praise) -> Testimony V -> Ch -> Spoken Testimony -> Final Ch", desc: "Spoken or sung testimony alternates with a communal praise chorus." },
                ],
                reggae: [
                    { name: "Classic Roots Reggae", tag: "Roots", flow: "Intro (riddim) -> V -> Ch -> V -> Ch -> Bridge -> Ch -> Outro", desc: "Steady one-drop rhythm anchors the whole track." },
                    { name: "One-Drop Anthem", tag: "One-Drop", flow: "Riddim Intro -> V -> Hook -> V -> Hook -> Dub Break -> Hook -> Outro", desc: "Dub break strips the music back mid-song." },
                    { name: "Dancehall Riddim", tag: "Dancehall", flow: "Riddim Intro -> Deejay V -> Hook -> Deejay V -> Hook -> Singjay Bridge -> Hook x2", desc: "Deejay-style toasting over a dancehall riddim." },
                    { name: "Lovers Rock", tag: "Lovers Rock", flow: "Soft Intro -> V -> Smooth Ch -> V -> Ch -> Spoken Bridge -> Final Ch", desc: "Gentle, romantic reggae." },
                    { name: "Conscious Roots", tag: "Conscious", flow: "Message Intro -> V (message) -> Refrain -> V (message) -> Refrain -> Chant Bridge -> Refrain", desc: "Politically conscious." },
                ],
                ska: [
                    { name: "Classic Ska", tag: "Classic", flow: "Horn Intro -> V -> Ch -> V -> Ch -> Instrumental Break -> Ch -> Outro", desc: "Upstroke guitar and punchy horns." },
                    { name: "Two-Tone Punk-Ska", tag: "Two-Tone", flow: "Fast Intro -> V -> Ch -> V -> Ch -> Bridge -> Ch x2 -> Outro", desc: "Punk energy at ska tempo." },
                    { name: "Third Wave Ska-Punk", tag: "Third Wave", flow: "Intro -> V -> PCh -> Ch -> V -> PCh -> Ch -> Breakdown -> Ch x2", desc: "Pre-chorus builds into a big singalong chorus." },
                    { name: "Rude Boy Anthem", tag: "Street Ska", flow: "Punchy Intro -> V -> Shout Ch -> V -> Shout Ch -> Breakdown -> Ch x3", desc: "Crowd-participation chorus repeated for maximum energy." },
                ],
                latin: [
                    { name: "Salsa Coro-Pregon", tag: "Salsa", flow: "Intro -> Coro (chorus) -> Pregon (verse improvisation) -> Mambo -> Coro -> Outro", desc: "Salsa's defining structure." },
                    { name: "Cumbia Verse-Chorus", tag: "Cumbia", flow: "Intro -> V -> Ch -> V -> Ch -> Accordion Break -> Ch -> Outro", desc: "Accordion or gaita break is structural." },
                    { name: "Afrobeats Groove", tag: "Afrobeats", flow: "Percussion Intro -> V -> Hook -> V -> Hook -> Afrobeat Breakdown -> Hook -> Outro", desc: "Polyrhythmic percussion intro sets the tone." },
                    { name: "Reggaeton Dem Bow", tag: "Reggaeton", flow: "Dem Bow Intro -> V -> Ch -> V -> Ch -> Bridge (rap) -> Ch x2 -> Outro", desc: "Dem bow rhythm drives everything." },
                    { name: "Bossa Nova Form", tag: "Bossa Nova", flow: "Guitar Intro -> A section -> B section -> A section -> Improvisation -> A -> Fade", desc: "Gentle two-part form with improvisation in the middle." },
                    { name: "Bolero Form", tag: "Bolero", flow: "Slow Intro -> V -> Refrain -> V -> Refrain -> Bridge -> Final Refrain", desc: "Romantic, slow Latin ballad." },
                ],
                cumbia: [
                    { name: "Traditional Cumbia", tag: "Traditional", flow: "Percussion Intro -> V -> Ch -> V -> Ch -> Gaita/Accordion Break -> Ch -> Outro", desc: "Classic Colombian cumbia form." },
                    { name: "Cumbia-Pop Fusion", tag: "Pop Cumbia", flow: "Intro -> V -> PCh -> Ch -> V -> PCh -> Ch -> Bridge -> Final Ch", desc: "Cumbia rhythm with contemporary pop structure." },
                    { name: "Modern Cumbia", tag: "Modern", flow: "Electronic Intro -> V -> Hook -> V -> Hook -> Drop -> Hook x2 -> Outro", desc: "Electronic production fused with cumbia rhythm." },
                ],
                electronic: [
                    { name: "EDM Build & Drop", tag: "EDM", flow: "Intro -> Build -> Drop -> V -> Build -> Drop -> Bridge -> Final Drop", desc: "Built around tension-release cycles with massive drops." },
                    { name: "House Groove", tag: "House", flow: "Beat Intro -> V -> Breakdown -> Drop -> V -> Breakdown -> Drop -> Outro", desc: "Four-on-the-floor rhythm with breakdowns leading to drops." },
                    { name: "Techno Loop Evolution", tag: "Techno", flow: "Minimal Intro -> Layer 1 -> Layer 2 -> Layer 3 -> Peak -> Breakdown -> Rebuild -> Outro", desc: "Gradual layering and evolution of looped elements." },
                    { name: "Trance Journey", tag: "Trance", flow: "Intro -> Build -> Breakdown -> Drop -> Interlude -> Build -> Euphoric Drop -> Outro", desc: "Emotional builds leading to euphoric releases." },
                    { name: "Dubstep Wobble", tag: "Dubstep", flow: "Intro -> Build -> Drop (wobble bass) -> V -> Build -> Drop -> Outro", desc: "Half-time breaks with heavy wobble bass drops." },
                    { name: "Drum & Bass Rush", tag: "DnB", flow: "Intro -> Drop -> V -> Breakdown -> Drop -> V -> Final Drop -> Outro", desc: "Fast breakbeats with deep basslines and atmospheric breaks." },
                ],
                ambient: [
                    { name: "Ambient Drift", tag: "Ambient", flow: "Emergence -> Development -> Plateau -> Dissolution", desc: "Sound gradually emerges, develops, sustains, then fades." },
                    { name: "Atmospheric Layers", tag: "Atmospheric", flow: "Layer 1 -> Layer 2 -> Layer 3 -> Peak -> Slow Fade", desc: "Gradual addition of textural layers building to a peaceful peak." },
                    { name: "Soundscape Evolution", tag: "Soundscape", flow: "Theme A -> Transition -> Theme B -> Transition -> Theme A' -> Outro", desc: "Two contrasting sonic environments linked by transitional passages." },
                    { name: "Minimal Meditation", tag: "Minimal", flow: "Single Element -> Subtle Variations -> Return -> Silence", desc: "Minimal elements with subtle changes over extended duration." },
                ],
                lofi: [
                    { name: "Lo-Fi Hip-Hop", tag: "Chill Beats", flow: "Intro Loop -> Beat Drop -> V -> Loop Break -> V -> Outro Loop", desc: "Relaxed beats with vinyl crackle and warm samples." },
                    { name: "Study Beats", tag: "Study", flow: "Piano Loop -> Beat Entry -> Development -> Breakdown -> Return -> Fade", desc: "Mellow, repetitive structure designed for background focus." },
                    { name: "Jazz Lo-Fi", tag: "Jazz Hop", flow: "Jazz Sample -> Beat -> Verse -> Sample Break -> Verse -> Outro", desc: "Jazz samples chopped over laid-back beats." },
                    { name: "Chill Vibe", tag: "Chill", flow: "Ambient Intro -> Groove -> Melody -> Groove Variation -> Outro", desc: "Relaxed progression with warm, nostalgic textures." },
                ],
                classical: [
                    { name: "Sonata Form", tag: "Sonata", flow: "Exposition -> Development -> Recapitulation", desc: "The cornerstone of classical structure: themes introduced, developed, then returned." },
                    { name: "Rondo", tag: "Rondo", flow: "A -> B -> A -> C -> A", desc: "Main theme returns between contrasting episodes." },
                    { name: "Theme & Variations", tag: "Variations", flow: "Theme -> Variation 1 -> Variation 2 -> Variation 3 -> Variation 4 -> Coda", desc: "A single theme transformed through multiple variations." },
                    { name: "Ternary (ABA)", tag: "ABA", flow: "Section A -> Section B -> Section A", desc: "Statement, contrast, return - simple and elegant." },
                    { name: "Through-Composed", tag: "Through-Composed", flow: "Section A -> Section B -> Section C -> Section D", desc: "Continuous development without repeated sections." },
                    { name: "Minuet & Trio", tag: "Dance", flow: "Minuet -> Trio -> Minuet da capo", desc: "Classical dance form with graceful return." },
                ],
                cinematic: [
                    { name: "Epic Trailer Build", tag: "Trailer", flow: "Tension Intro -> Rising Action -> Climax -> Impact -> Aftermath", desc: "Dramatic build designed for maximum emotional impact." },
                    { name: "Film Score Arc", tag: "Film Score", flow: "Theme Introduction -> Conflict -> Resolution -> Epilogue", desc: "Follows narrative arc with distinct emotional movements." },
                    { name: "Heroic Journey", tag: "Epic", flow: "Awakening -> Call to Adventure -> Battle -> Victory -> Celebration", desc: "Classic hero's journey in musical form." },
                    { name: "Orchestral Suite", tag: "Suite", flow: "Overture -> Movement I -> Movement II -> Movement III -> Finale", desc: "Multi-movement orchestral work with contrasting sections." },
                    { name: "Tension & Release", tag: "Suspense", flow: "Quiet Tension -> Building Dread -> Climax -> Resolution", desc: "Builds unbearable tension before cathartic release." },
                ],
                world: [
                    { name: "Call & Response", tag: "Traditional", flow: "Call -> Response -> Call -> Response -> Instrumental -> Call -> Response", desc: "Universal form found across many world music traditions." },
                    { name: "Cyclical Form", tag: "Cyclical", flow: "Theme -> Variation 1 -> Variation 2 -> Variation 3 -> Return to Theme", desc: "Circular structure common in many non-Western traditions." },
                    { name: "Raga Development", tag: "Indian Classical", flow: "Alap (intro) -> Jor (rhythm) -> Jhala (climax) -> Gat (composition)", desc: "Indian classical music's gradual rhythmic intensification." },
                    { name: "Flamenco Structure", tag: "Flamenco", flow: "Intro -> Letra (verse) -> Falseta (guitar) -> Letra -> Escobilla (footwork) -> Finale", desc: "Spanish flamenco with guitar interludes and percussive dance." },
                    { name: "African Polyrhythm", tag: "African", flow: "Rhythm Foundation -> Layer 2 -> Layer 3 -> Call & Response -> Peak -> Outro", desc: "Interlocking rhythmic layers build to communal peak." },
                ],
                pop: [
                    { name: "Standard Pop", tag: "Pop", flow: "Intro -> V -> Ch -> V -> Ch -> Bridge -> Ch -> Outro", desc: "The universal pop song structure - proven and effective." },
                    { name: "Hit Single Format", tag: "Radio", flow: "Intro -> V -> PCh -> Ch -> Post-Ch -> V -> PCh -> Ch -> Bridge -> Final Ch", desc: "Modern pop with pre-chorus and post-chorus hooks." },
                    { name: "Verse-Verse-Chorus", tag: "Alternative", flow: "Intro -> V -> V -> Ch -> V -> V -> Ch -> Bridge -> Ch", desc: "Delayed chorus creates anticipation." },
                    { name: "Dance-Pop Drop", tag: "Dance Pop", flow: "Intro -> V -> Build -> Drop -> V -> Build -> Drop -> Bridge -> Final Drop", desc: "EDM-influenced structure with explosive drops." },
                    { name: "Power Ballad", tag: "Ballad", flow: "Piano Intro -> Soft V -> Build Ch -> V -> Full Ch -> Bridge -> Final Ch (key change)", desc: "Starts intimate, builds to powerful climax with key change." },
                ],
                christian: [
                    { name: "Contemporary Worship", tag: "Worship", flow: "Intro -> V -> Ch -> V -> Ch -> Bridge (spontaneous) -> Ch -> Outro", desc: "Modern worship structure with open bridge for spontaneous worship." },
                    { name: "Traditional Hymn", tag: "Hymn", flow: "V1 -> V2 -> V3 -> V4", desc: "Four verses tell progressive story of faith." },
                    { name: "Praise Anthem", tag: "Anthem", flow: "Intro -> V -> PCh -> Ch -> V -> PCh -> Ch -> Bridge -> Ch x2", desc: "High-energy praise with repeating chorus for congregation participation." },
                    { name: "Contemplative", tag: "Contemplative", flow: "Gentle Intro -> V -> Ch -> Instrumental Reflection -> V -> Ch -> Outro", desc: "Reflective structure with instrumental meditation." },
                    { name: "Gospel Vamp", tag: "Gospel", flow: "V -> Ch -> V -> Ch -> Modulation -> Vamp -> Shout", desc: "Builds through key modulation to energetic vamp and shout section." },
                ],
            };

            const DEFAULT_STRUCTURES = [{ name: "Verse-Chorus", tag: "Universal", flow: "Intro -> V -> Ch -> V -> Ch -> Bridge -> Ch -> Outro", desc: "The most versatile song form across all popular genres." }];

            // ========================================================================
            // State
            // Global application state variables
            // ========================================================================
            let history = [],
                currentSong = null,
                lyricsMode = "single",
                activeLeftTab = "settings";
            let selectedStructure = null,
                currentGenreKey = "rock",
                influences = [],
                customStructureOption = null,
                customStructureDraft = [],
                customStructurePoints = [];

            // Debug mode state
            let debugMode = false;
            let debugLogs = [];

            function debugLog(category, message, data = null) {
                const timestamp = new Date().toISOString();
                const logEntry = {
                    timestamp,
                    category,
                    message,
                    data: data ? (typeof data === "object" ? JSON.stringify(data, null, 2) : String(data)) : null,
                };

                if (debugMode) {
                    debugLogs.push(logEntry);
                    console.log(`[${category}] ${message}`, data || "");
                }
            }

            function toggleDebugMode() {
                debugMode = !debugMode;
                const indicator = document.getElementById("debug-indicator");

                if (debugMode) {
                    // Enable debug mode
                    indicator.style.display = "block";
                    debugLogs = [];
                    debugLog("SYSTEM", "Debug mode ENABLED");
                    debugLog("STATE", "Current Genre", currentGenreKey);
                    debugLog("STATE", "Current Structure", selectedStructure?.name || "None");
                    debugLog("STATE", "Active Tab", activeLeftTab);
                } else {
                    // Disable debug mode - export logs
                    debugLog("SYSTEM", "Debug mode DISABLED");
                    indicator.style.display = "none";
                    downloadDebugLogs();
                }
            }

            function downloadDebugLogs() {
                const now = new Date();
                const dd = String(now.getDate()).padStart(2, "0");
                const mm = String(now.getMonth() + 1).padStart(2, "0");
                const yy = String(now.getFullYear()).slice(-2);
                const hh = String(now.getHours()).padStart(2, "0");
                const min = String(now.getMinutes()).padStart(2, "0");
                const filename = `sunoforge_debug-${dd}${mm}${yy}_${hh}${min}.txt`;

                const version = document.getElementById("version")?.textContent || "Unknown";

                let content = `SunoForge Debug Log\n`;
                content += `Version: ${version}\n`;
                content += `Generated: ${now.toISOString()}\n`;
                content += `Session Duration: ${debugLogs.length > 0 ? "Active" : "N/A"}\n`;
                content += `Total Log Entries: ${debugLogs.length}\n`;
                content += `=`.repeat(80) + `\n\n`;

                // Add all debug logs
                debugLogs.forEach((log, idx) => {
                    content += `[${idx + 1}] ${log.timestamp}\n`;
                    content += `Category: ${log.category}\n`;
                    content += `Message: ${log.message}\n`;
                    if (log.data) {
                        content += `Data:\n${log.data}\n`;
                    }
                    content += `-`.repeat(80) + `\n\n`;
                });

                // Add current song export if available
                if (currentSong) {
                    content += `\n` + `=`.repeat(80) + `\n`;
                    content += `CURRENT SONG EXPORT\n`;
                    content += `=`.repeat(80) + `\n\n`;

                    content += `Title: ${currentSong.title || "Untitled"}\n`;
                    content += `Genre: ${currentSong.genre || "N/A"}\n`;
                    content += `Structure: ${currentSong.structureName || "N/A"}\n\n`;

                    if (currentSong.suno_style_prompt) {
                        content += `--- SUNO STYLE PROMPT ---\n${currentSong.suno_style_prompt}\n\n`;
                    }

                    if (currentSong.sections && currentSong.sections.length > 0) {
                        content += `--- LYRICS ---\n`;
                        currentSong.sections.forEach((s) => {
                            const strippedLines = stripAllLeadingMetaTags(s.lines || "");
                            const metaTagLines = collectSectionMetaTags(s)
                                .map((tag) => `\n[${tag}]`)
                                .join("");

                            content += `\n[${s.type}]`;
                            content += metaTagLines;
                            content += `\n${strippedLines}\n`;
                        });
                    }
                }

                // Create download
                const blob = new Blob([content], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);

                // Clear logs
                debugLogs = [];
            }

            const CUSTOM_STRUCTURE_POINTS = ["Intro", "Vamp", "Verse 1", "Verse 2", "Verse 3", "Verse 4", "Pre-Chorus", "Chorus", "Post-Chorus", "Hook", "Refrain", "Bridge", "Solo", "Instrumental Break", "Breakdown", "Interlude", "Build", "Drop", "Final Chorus", "Tag", "Coda", "Outro", "End"];

            // ========================================================================
            // Tag Setup
            // ========================================================================
            function setupSingleTags(id) {
                const g = document.getElementById(id);
                g.querySelectorAll(".tag").forEach((t) => {
                    t.addEventListener("click", () => {
                        const wasActive = t.classList.contains("active");
                        g.querySelectorAll(".tag").forEach((x) => x.classList.remove("active"));
                        if (wasActive) return;
                        t.classList.add("active");
                        if (id === "rhyme-tags") clearCustomRhyme();
                        if (id === "mood-tags") clearCustomSingleValue("mood-custom-row", "mood-custom-tag");
                        if (id === "goal-tags") clearCustomSingleValue("goal-custom-row", "goal-custom-tag");
                        if (id === "rhythm-tags") clearCustomSingleValue("rhythm-custom-row", "rhythm-custom-tag");
                        if (id === "groove-tags") clearCustomSingleValue("groove-custom-row", "groove-custom-tag");
                        if (id === "bass-tags") clearCustomSingleValue("bass-custom-row", "bass-custom-tag");
                        if (id === "pov-tags") clearCustomSingleValue("pov-custom-row", "pov-custom-tag");
                    });
                });
            }
            ["mood-tags", "goal-tags", "rhythm-tags", "groove-tags", "bass-tags", "rhyme-tags", "pov-tags", "aimode-tags"].forEach(setupSingleTags);

            // Initialize the new hierarchical genre selector
            initializeGenreSelector();

            ["era-tags", "instruments-tags", "prodstyle-tags", "inst-tags", "spatial-tags", "mix-tags"].forEach((id) => {
                document
                    .getElementById(id)
                    .querySelectorAll(".tag")
                    .forEach((t) => {
                        t.addEventListener("click", () => {
                            t.classList.toggle("active");
                        });
                    });
            });

            // Initialize vocal profiles
            buildVocalProfiles();

            document
                .getElementById("inf-suggest-tags")
                .querySelectorAll(".tag")
                .forEach((t) => {
                    t.addEventListener("click", () => {
                        const val = t.dataset.inf;
                        if (!influences.includes(val)) addInfluenceVal(val);
                        t.classList.add("active");
                    });
                });

            function toggleTempoMode() {
                const mode = document.getElementById("tempo-mode")?.value || "ai";
                const row = document.getElementById("tempo-custom-row");
                if (!row) return;
                row.style.display = mode === "custom" ? "flex" : "none";
                if (mode !== "custom") {
                    const minInput = document.getElementById("tempo-min");
                    const maxInput = document.getElementById("tempo-max");
                    if (minInput) minInput.value = "90";
                    if (maxInput) maxInput.value = "90";
                    updateTempoRange();
                }
            }
            function toggleDurationMode() {
                const mode = document.getElementById("duration-mode")?.value || "none";
                const row = document.getElementById("duration-custom-row");
                if (!row) return;
                row.style.display = mode === "custom" ? "flex" : "none";
                if (mode !== "custom") {
                    const minInput = document.getElementById("duration-min");
                    const maxInput = document.getElementById("duration-max");
                    if (minInput) minInput.value = "180";
                    if (maxInput) maxInput.value = "180";
                    updateDurationRange();
                }
            }
            function toggleTimeSignatureMode() {
                const value = document.getElementById("time-signature")?.value || "4/4";
                const row = document.getElementById("time-signature-custom-row");
                if (!row) return;
                row.style.display = value === "Custom" ? "block" : "none";
                if (value !== "Custom") {
                    const customInput = document.getElementById("time-signature-custom");
                    if (customInput) customInput.value = "";
                }
            }
            function updateTempoRange() {
                const minInput = document.getElementById("tempo-min");
                const maxInput = document.getElementById("tempo-max");
                const display = document.getElementById("tempo-range-display");
                if (!minInput || !maxInput || !display) return;

                let min = parseInt(minInput.value);
                let max = parseInt(maxInput.value);

                // Ensure min doesn't exceed max
                if (min > max) {
                    max = min;
                    maxInput.value = min;
                }

                if (min === max) {
                    display.textContent = `${min} BPM`;
                } else {
                    display.textContent = `${min} - ${max} BPM`;
                }
            }
            function updateDurationRange() {
                const minInput = document.getElementById("duration-min");
                const maxInput = document.getElementById("duration-max");
                const display = document.getElementById("duration-range-display");
                if (!minInput || !maxInput || !display) return;

                let min = parseInt(minInput.value);
                let max = parseInt(maxInput.value);

                // Ensure min doesn't exceed max
                if (min > max) {
                    max = min;
                    maxInput.value = min;
                }

                const formatTime = (seconds) => {
                    const mins = Math.floor(seconds / 60);
                    const secs = seconds % 60;
                    return `${mins}:${secs.toString().padStart(2, "0")}`;
                };

                if (min === max) {
                    display.textContent = formatTime(min);
                } else {
                    display.textContent = `${formatTime(min)} - ${formatTime(max)}`;
                }
            }
            function getTempoPreference() {
                const mode = document.getElementById("tempo-mode")?.value || "ai";
                if (mode !== "custom") return "";

                const min = parseInt(document.getElementById("tempo-min")?.value || "90");
                const max = parseInt(document.getElementById("tempo-max")?.value || "90");

                if (min === max) {
                    return `${min} BPM`;
                } else {
                    return `${min}-${max} BPM`;
                }
            }
            function getDurationPreference() {
                const mode = document.getElementById("duration-mode")?.value || "none";
                if (mode !== "custom") return null;

                const min = parseInt(document.getElementById("duration-min")?.value || "180");
                const max = parseInt(document.getElementById("duration-max")?.value || "180");

                const formatTime = (seconds) => {
                    const mins = Math.floor(seconds / 60);
                    const secs = seconds % 60;
                    if (mins > 0 && secs > 0) return `${mins} minute${mins !== 1 ? "s" : ""} ${secs} second${secs !== 1 ? "s" : ""}`;
                    if (mins > 0) return `${mins} minute${mins !== 1 ? "s" : ""}`;
                    return `${secs} second${secs !== 1 ? "s" : ""}`;
                };

                if (min === max) {
                    return formatTime(min);
                } else {
                    return `Between ${formatTime(min)} and ${formatTime(max)}`;
                }
            }
            function formatTempoPreference(value) {
                // If no value provided, try to get from sliders
                if (!value) {
                    const mode = document.getElementById("tempo-mode")?.value;
                    if (mode === "custom") {
                        value = getTempoPreference();
                    }
                }
                const normalized = String(value || "").trim();
                if (!normalized || /^ai choose$/i.test(normalized) || /^auto$/i.test(normalized)) return "AI Choose";
                return normalized;
            }
            function applyTempoPreference(value) {
                const normalized = formatTempoPreference(value);
                const mode = document.getElementById("tempo-mode");
                const minInput = document.getElementById("tempo-min");
                const maxInput = document.getElementById("tempo-max");
                if (!mode || !minInput || !maxInput) return;

                if (normalized === "AI Choose") {
                    mode.value = "ai";
                    minInput.value = "90";
                    maxInput.value = "90";
                } else {
                    mode.value = "custom";
                    // Parse BPM range like "90-110 BPM" or "100 BPM"
                    const match = normalized.match(/(\d+)(?:-(\d+))?/);
                    if (match) {
                        const min = parseInt(match[1]);
                        const max = match[2] ? parseInt(match[2]) : min;
                        minInput.value = min.toString();
                        maxInput.value = max.toString();
                    }
                }
                updateTempoRange();
                toggleTempoMode();
            }
            function formatLengthPreference(value) {
                return String(value || "").trim() || "Follow Structure";
            }

            function getActive(id) {
                const el = document.getElementById(id).querySelector(".tag.active");
                return el ? el.dataset.val : "";
            }
            function getCustomTagValue(tagId) {
                return document.getElementById(tagId)?.dataset.val?.trim() || "";
            }
            function clearCustomSingleValue(rowId, tagId) {
                const row = document.getElementById(rowId);
                const tag = document.getElementById(tagId);
                if (!row || !tag) return;
                row.style.display = "none";
                tag.textContent = "";
                tag.dataset.val = "";
            }
            function removeCustomSingleValue(rowId, tagId, groupId) {
                clearCustomSingleValue(rowId, tagId);
            }
            function setCustomSingleValue(rowId, tagId, prefix, value) {
                const row = document.getElementById(rowId);
                const tag = document.getElementById(tagId);
                if (!row || !tag) return;
                tag.dataset.val = value;
                let groupId = "";
                if (tagId === "genre-custom-tag") groupId = "genre-tags";
                if (tagId === "mood-custom-tag") groupId = "mood-tags";
                if (tagId === "goal-custom-tag") groupId = "goal-tags";
                if (tagId === "rhythm-custom-tag") groupId = "rhythm-tags";
                if (tagId === "groove-custom-tag") groupId = "groove-tags";
                if (tagId === "bass-custom-tag") groupId = "bass-tags";
                if (tagId === "pov-custom-tag") groupId = "pov-tags";
                if (tagId === "vocalgender-custom-tag") groupId = "vocalgender-tags";
                if (tagId === "rhyme-custom-tag") groupId = "rhyme-tags";
                tag.innerHTML = `${escapeHtml(prefix)}: ${escapeHtml(value)}<span class="tag-custom-x" onclick="removeCustomSingleValue('${escapeAttr(rowId)}','${escapeAttr(tagId)}','${escapeAttr(groupId)}')">x</span>`;
                row.style.display = "flex";
            }
            function applySingleTagOrCustom(id, value, rowId, tagId, prefix) {
                if (!value) return false;
                const normalized = value.trim().toLowerCase();
                let matched = false;
                document
                    .getElementById(id)
                    .querySelectorAll(".tag")
                    .forEach((t) => {
                        const isMatch = (t.dataset.val || "").trim().toLowerCase() === normalized;
                        t.classList.toggle("active", isMatch);
                        if (isMatch) matched = true;
                    });
                if (matched) {
                    clearCustomSingleValue(rowId, tagId);
                    return true;
                }
                setCustomSingleValue(rowId, tagId, prefix, value.trim());
                return false;
            }
            function getSelectedRhymeScheme() {
                const custom = document.getElementById("rhyme-custom-tag")?.dataset.val?.trim();
                return custom || getActive("rhyme-tags");
            }
            function getSongLanguage() {
                const sel = document.getElementById("song-language");
                if (!sel) return "English";
                if (sel.value === "custom") {
                    return document.getElementById("song-language-custom").value.trim() || "English";
                }
                return sel.value;
            }
            function onSongLanguageChange(sel) {
                const custom = document.getElementById("song-language-custom");
                custom.style.display = sel.value === "custom" ? "" : "none";
                localStorage.setItem("sf_song_lang", sel.value);
                if (sel.value !== "custom") {
                    localStorage.removeItem("sf_song_lang_custom");
                    if (custom) custom.value = "";
                }
                persistSyncedSettings();
            }
            function applySongLanguageSetting(lang) {
                if (!lang) return;
                const sel = document.getElementById("song-language");
                const custom = document.getElementById("song-language-custom");
                if (!sel) return;
                const opt = Array.from(sel.options).find((o) => o.value === lang);
                if (opt) {
                    sel.value = lang;
                    custom.style.display = "none";
                } else {
                    sel.value = "custom";
                    custom.value = lang;
                    custom.style.display = "";
                }
            }
            function getSelectedMood() {
                return getCustomTagValue("mood-custom-tag") || getActive("mood-tags");
            }
            function getSelectedGoal() {
                return getCustomTagValue("goal-custom-tag") || getActive("goal-tags");
            }
            function getSelectedRhythm() {
                return getCustomTagValue("rhythm-custom-tag") || getActive("rhythm-tags");
            }
            function getSelectedGrooveFeel() {
                return getCustomTagValue("groove-custom-tag") || getActive("groove-tags");
            }
            function getSelectedBass() {
                return getCustomTagValue("bass-custom-tag") || getActive("bass-tags");
            }
            function getSelectedSpatialEffects() {
                return getActiveMulti("spatial-tags");
            }
            function getSelectedPov() {
                return getCustomTagValue("pov-custom-tag") || getActive("pov-tags");
            }
            // ========================================================================
            // Vocal Profile Builder
            // Handles vocal type selection, profile creation, and choir configuration
            // ========================================================================
            function selectVocalType(el) {
                document.querySelectorAll("#vocal-type-tags .tag").forEach((t) => t.classList.remove("active"));
                el.classList.add("active");
                const isInstrumental = el.dataset.val === "Instrumental";
                const isChoirEnsemble = el.dataset.val === "Choir/Ensemble";
                const hideProfiles = isInstrumental || isChoirEnsemble;
                document.getElementById("vocal-profiles-container").style.display = hideProfiles ? "none" : "block";
                document.getElementById("choir-enable-container").style.display = hideProfiles ? "none" : "block";
                document.getElementById("vocal-config-info").style.display = hideProfiles ? "none" : "block";
                document.getElementById("instrumental-info").style.display = isInstrumental ? "block" : "none";
                const choirBuilderContainer = document.getElementById("choir-builder-container");
                if (isChoirEnsemble) {
                    choirBuilderContainer.style.display = "block";
                    buildChoirBuilder();
                } else if (!document.getElementById("choir-enabled")?.checked) {
                    choirBuilderContainer.style.display = "none";
                }
                buildVocalProfiles();
            }

            function toggleChoir(enabled) {
                const container = document.getElementById("choir-builder-container");
                if (enabled) {
                    container.style.display = "block";
                    buildChoirBuilder();
                } else {
                    container.style.display = "none";
                }
            }

            function buildChoirBuilder() {
                const container = document.getElementById("choir-builder-container");
                container.innerHTML = `
                                    <div class="choir-builder">
                                        <div class="choir-header">Ensemble/Backing Vocals</div>
                                        <div class="vocal-profile-row">
                                            <div class="vocal-profile-field">
                                                <label for="choir-gender">Gender</label>
                                                <select id="choir-gender">
                                                    <option value="Male">Male</option>
                                                    <option value="Female">Female</option>
                                                    <option value="Both" selected>Both</option>
                                                </select>
                                            </div>
                                            <div class="vocal-profile-field">
                                                <label for="choir-size">Size</label>
                                                <select id="choir-size">
                                                    <option value="Small (Vocal Ensemble)">Small (Vocal Ensemble)</option>
                                                    <option value="Medium (Chamber)" selected>Medium (Chamber)</option>
                                                    <option value="Large (Chorus)">Large (Chorus)</option>
                                                    <option value="Extra Large (Massed)">Extra Large (Massed)</option>
                                                </select>
                                            </div>
                                        </div>
                                        <div class="vocal-profile-field">
                                            <div class="field-label">Vocal Range (optional)</div>
                                            <div class="vocal-style-tags" id="choir-range-tags">
                                                <div class="tag multi" data-val="Bass">Bass</div>
                                                <div class="tag multi" data-val="Baritone">Baritone</div>
                                                <div class="tag multi" data-val="Tenor">Tenor</div>
                                                <div class="tag multi" data-val="Countertenor">Countertenor</div>
                                                <div class="tag multi" data-val="Contralto">Contralto</div>
                                                <div class="tag multi" data-val="Mezzo-Soprano">Mezzo-Soprano</div>
                                                <div class="tag multi" data-val="Soprano">Soprano</div>
                                            </div>
                                        </div>
                                        <div class="vocal-profile-field">
                                            <div class="field-label">Accent (optional)</div>
                                            <div class="accent-chips" id="choir-accent-tags">
                                                <div class="tag multi" data-val="American">American</div>
                                                <div class="tag multi" data-val="Australian">Australian</div>
                                                <div class="tag multi" data-val="British">British</div>
                                                <div class="tag multi" data-val="New Zealand">New Zealand</div>
                                                <div class="tag multi" data-val="Spanish">Spanish</div>
                                                <div class="tag multi" data-val="French">French</div>
                                                <div class="tag multi" data-val="Italian">Italian</div>
                                                <div class="tag multi" data-val="German">German</div>
                                                <div class="tag multi" data-val="Russian">Russian</div>
                                                <div class="tag multi" data-val="Japanese">Japanese</div>
                                                <div class="tag multi" data-val="Chinese">Chinese</div>
                                                <div class="tag multi" data-val="Korean">Korean</div>
                                                <div class="tag multi" data-val="African">African</div>
                                                <div class="tag multi" data-val="Jamaican">Jamaican</div>
                                                <button class="tag-add-btn" onclick="showCustomInput('choir-accent-tags', 'choir-accent-custom-input-row')">+ Custom</button>
                                            </div>
                                            <div class="custom-input-row" id="choir-accent-custom-input-row" style="display: none; margin-top: 4px">
                                                <input type="text" id="choir-accent-custom-input" placeholder="e.g. Irish, Scottish..." onkeydown="if (event.key === 'Enter') confirmCustomTag('choir-accent-tags', 'choir-accent-custom-input', 'choir-accent-custom-input-row');" />
                                                <button class="custom-input-confirm" onclick="confirmCustomTag('choir-accent-tags', 'choir-accent-custom-input', 'choir-accent-custom-input-row')">Add</button>
                                                <button class="custom-input-cancel" onclick="hideCustomInput('choir-accent-custom-input-row', 'choir-accent-custom-input')">x</button>
                                            </div>
                                        </div>
                                        <div class="vocal-profile-field">
                                            <div class="field-label">Style (optional)</div>
                                            <div class="vocal-style-tags" id="choir-style-tags">
                                                <div class="tag multi" data-val="Clean">Clean</div>
                                                <div class="tag multi" data-val="Gritty">Gritty</div>
                                                <div class="tag multi" data-val="Deep">Deep</div>
                                                <div class="tag multi" data-val="Breathy">Breathy</div>
                                                <div class="tag multi" data-val="Airy">Airy</div>
                                                <div class="tag multi" data-val="Etherial">Etherial</div>
                                                <div class="tag multi" data-val="Raspy">Raspy</div>
                                                <div class="tag multi" data-val="Smooth">Smooth</div>
                                                <div class="tag multi" data-val="Powerful">Powerful</div>
                                                <div class="tag multi" data-val="Falsetto">Falsetto</div>
                                                <div class="tag multi" data-val="High-Pitched">High-Pitched</div>
                                                <div class="tag multi" data-val="Husky">Husky</div>
                                                <div class="tag multi" data-val="Sultry">Sultry</div>
                                                <div class="tag multi" data-val="Restrained">Restrained</div>
                                                <div class="tag multi" data-val="Dynamic">Dynamic</div>
                                                <div class="tag multi" data-val="Wide Vocal Range">Wide Range</div>
                                                <div class="tag multi" data-val="Vocalization">Vocalization</div>
                                                <div class="tag multi" data-val="Robotic">Robotic</div>
                                                <div class="tag multi" data-val="Autotuned">Autotuned</div>
                                                <div class="tag multi" data-val="Pitched Vocals">Pitched Vocals</div>
                                                <button class="tag-add-btn" onclick="showCustomInput('choir-style-tags', 'choir-style-custom-input-row')">+ Custom</button>
                                            </div>
                                            <div class="custom-input-row" id="choir-style-custom-input-row" style="display: none; margin-top: 4px">
                                                <input type="text" id="choir-style-custom-input" placeholder="e.g. Raspy, Operatic, Soulful..." onkeydown="if (event.key === 'Enter') confirmCustomTag('choir-style-tags', 'choir-style-custom-input', 'choir-style-custom-input-row');" />
                                                <button class="custom-input-confirm" onclick="confirmCustomTag('choir-style-tags', 'choir-style-custom-input', 'choir-style-custom-input-row')">Add</button>
                                                <button class="custom-input-cancel" onclick="hideCustomInput('choir-style-custom-input-row', 'choir-style-custom-input')">x</button>
                                            </div>
                                        </div>
                                    </div>
                                `;

                // Setup click handlers for choir tags
                container.querySelectorAll(".tag.multi").forEach((tag) => {
                    tag.addEventListener("click", () => tag.classList.toggle("active"));
                });
            }

            function getChoirConfig() {
                const vocalType = document.querySelector("#vocal-type-tags .tag.active")?.dataset.val || "Single Male";
                const isChoirEnsemble = vocalType === "Choir/Ensemble";
                const enabled = isChoirEnsemble || document.getElementById("choir-enabled")?.checked || false;
                if (!enabled) return null;

                const gender = document.getElementById("choir-gender")?.value || "Both";
                const size = document.getElementById("choir-size")?.value || "Medium (Chamber)";

                const rangeContainer = document.getElementById("choir-range-tags");
                const ranges = rangeContainer ? [...rangeContainer.querySelectorAll(".tag.active")].map((t) => t.dataset.val) : [];

                const accentContainer = document.getElementById("choir-accent-tags");
                const accents = accentContainer ? [...accentContainer.querySelectorAll(".tag.active, .tag-custom")].map((t) => t.dataset.val).filter(Boolean) : [];

                const styleContainer = document.getElementById("choir-style-tags");
                const styles = styleContainer ? [...styleContainer.querySelectorAll(".tag.active, .tag-custom")].map((t) => t.dataset.val).filter(Boolean) : [];

                const config = { gender, size };
                if (ranges.length) config.ranges = ranges;
                if (accents.length) config.accents = accents;
                if (styles.length) config.styles = styles;

                return config;
            }

            function buildVocalProfiles() {
                const vocalType = document.querySelector("#vocal-type-tags .tag.active")?.dataset.val || "Single Male";
                const container = document.getElementById("vocal-profiles-container");
                container.innerHTML = "";

                // Skip building profiles for instrumental/choir-only tracks
                if (vocalType === "Instrumental" || vocalType === "Choir/Ensemble") {
                    return;
                }

                let profiles = [];
                if (vocalType === "Single Male") {
                    profiles = [{ label: "Male Vocal", gender: "Male" }];
                } else if (vocalType === "Single Female") {
                    profiles = [{ label: "Female Vocal", gender: "Female" }];
                } else if (vocalType === "Male Duo") {
                    profiles = [
                        { label: "Male Vocal 1", gender: "Male" },
                        { label: "Male Vocal 2", gender: "Male" },
                    ];
                } else if (vocalType === "Female Duo") {
                    profiles = [
                        { label: "Female Vocal 1", gender: "Female" },
                        { label: "Female Vocal 2", gender: "Female" },
                    ];
                } else if (vocalType === "Male & Female Duo") {
                    profiles = [
                        { label: "Male Vocal", gender: "Male" },
                        { label: "Female Vocal", gender: "Female" },
                    ];
                }

                profiles.forEach((profile, idx) => {
                    const profileDiv = document.createElement("div");
                    profileDiv.className = "vocal-profile-builder";
                    profileDiv.innerHTML = `
                                        <div class="vocal-profile-header">${profile.label}</div>
                                        <div class="vocal-profile-row">
                                            <div class="vocal-profile-field">
                                                <label for="vp-gender-${idx}">Gender</label>
                                                <select id="vp-gender-${idx}" name="vp-gender-${idx}" class="vp-gender" data-idx="${idx}">
                                                    <option value="Male" ${profile.gender === "Male" ? "selected" : ""}>Male</option>
                                                    <option value="Female" ${profile.gender === "Female" ? "selected" : ""}>Female</option>
                                                </select>
                                            </div>
                                            <div class="vocal-profile-field">
                                                <label for="vp-range-${idx}">Range</label>
                                                <select id="vp-range-${idx}" name="vp-range-${idx}" class="vp-range" data-idx="${idx}">
                                                    <option value="">Not specified</option>
                                                    ${
                                                        profile.gender === "Male"
                                                            ? `
                                                    <option value="Bass">Bass</option>
                                                    <option value="Baritone">Baritone</option>
                                                    <option value="Tenor">Tenor</option>
                                                    <option value="Countertenor">Countertenor</option>
                                                    `
                                                            : ""
                                                    }
                                                    ${
                                                        profile.gender === "Female"
                                                            ? `
                                                    <option value="Contralto">Contralto</option>
                                                    <option value="Mezzo-Soprano">Mezzo-Soprano</option>
                                                    <option value="Soprano">Soprano</option>
                                                    `
                                                            : ""
                                                    }
                                                    <option value="__custom__">+ Custom Range...</option>
                                                </select>
                                            </div>
                                            <div class="vocal-profile-field" id="vp-custom-range-row-${idx}" style="display: none; margin-top: 4px">
                                                <label for="vp-custom-range-input-${idx}">Custom Range</label>
                                                <div class="custom-input-row" style="margin-top: 0">
                                                    <input type="text" id="vp-custom-range-input-${idx}" name="vp-custom-range-input-${idx}" placeholder="e.g. Low Baritone, High Tenor..." onkeydown="if (event.key === 'Enter') confirmCustomRange(${idx});" />
                                                    <button class="custom-input-confirm" onclick="confirmCustomRange(${idx})">Set</button>
                                                    <button class="custom-input-cancel" onclick="cancelCustomRange(${idx})">Cancel</button>
                                                </div>
                                            </div>
                                        </div>
                                        <div class="vocal-profile-field">
                                            <div class="field-label">Accent (optional)</div>
                                            <div class="accent-chips" id="vp-accent-${idx}">
                                                <div class="tag multi" data-val="American">American</div>
                                                <div class="tag multi" data-val="Australian">Australian</div>
                                                <div class="tag multi" data-val="British">British</div>
                                                <div class="tag multi" data-val="New Zealand">New Zealand</div>
                                                <div class="tag multi" data-val="Spanish">Spanish</div>
                                                <div class="tag multi" data-val="French">French</div>
                                                <div class="tag multi" data-val="Italian">Italian</div>
                                                <div class="tag multi" data-val="German">German</div>
                                                <div class="tag multi" data-val="Russian">Russian</div>
                                                <div class="tag multi" data-val="Japanese">Japanese</div>
                                                <div class="tag multi" data-val="Chinese">Chinese</div>
                                                <div class="tag multi" data-val="Korean">Korean</div>
                                                <div class="tag multi" data-val="African">African</div>
                                                <div class="tag multi" data-val="Jamaican">Jamaican</div>
                                                <button class="tag-add-btn" onclick="showCustomInput('vp-accent-${idx}', 'vp-accent-custom-input-row-${idx}')">+ Custom</button>
                                            </div>
                                            <div class="custom-input-row" id="vp-accent-custom-input-row-${idx}" style="display: none; margin-top: 4px">
                                                <input type="text" id="vp-accent-custom-input-${idx}" placeholder="e.g. Irish, Scottish..." onkeydown="if (event.key === 'Enter') confirmCustomTag('vp-accent-${idx}', 'vp-accent-custom-input-${idx}', 'vp-accent-custom-input-row-${idx}');" />
                                                <button class="custom-input-confirm" onclick="confirmCustomTag('vp-accent-${idx}', 'vp-accent-custom-input-${idx}', 'vp-accent-custom-input-row-${idx}')">Add</button>
                                                <button class="custom-input-cancel" onclick="hideCustomInput('vp-accent-custom-input-row-${idx}', 'vp-accent-custom-input-${idx}')">x</button>
                                            </div>
                                        </div>
                                        <div class="vocal-profile-field">
                                            <div class="field-label">Style (optional)</div>
                                            <div class="vocal-style-tags" id="vp-style-${idx}">
                                                <div class="tag multi" data-val="Clean">Clean</div>
                                                <div class="tag multi" data-val="Gritty">Gritty</div>
                                                <div class="tag multi" data-val="Deep">Deep</div>
                                                <div class="tag multi" data-val="Breathy">Breathy</div>
                                                <div class="tag multi" data-val="Airy">Airy</div>
                                                <div class="tag multi" data-val="Etherial">Etherial</div>
                                                <div class="tag multi" data-val="Raspy">Raspy</div>
                                                <div class="tag multi" data-val="Smooth">Smooth</div>
                                                <div class="tag multi" data-val="Powerful">Powerful</div>
                                                <div class="tag multi" data-val="Falsetto">Falsetto</div>
                                                <div class="tag multi" data-val="High-Pitched">High-Pitched</div>
                                                <div class="tag multi" data-val="Husky">Husky</div>
                                                <div class="tag multi" data-val="Sultry">Sultry</div>
                                                <div class="tag multi" data-val="Restrained">Restrained</div>
                                                <div class="tag multi" data-val="Dynamic">Dynamic</div>
                                                <div class="tag multi" data-val="Wide Vocal Range">Wide Range</div>
                                                <div class="tag multi" data-val="Vocalization">Vocalization</div>
                                                <div class="tag multi" data-val="Robotic">Robotic</div>
                                                <div class="tag multi" data-val="Autotuned">Autotuned</div>
                                                <div class="tag multi" data-val="Pitched Vocals">Pitched Vocals</div>                                                
                                                <button class="tag-add-btn" onclick="showCustomInput('vp-style-${idx}', 'vp-style-custom-input-row-${idx}')">+ Custom</button>
                                            </div>
                                            <div class="custom-input-row" id="vp-style-custom-input-row-${idx}" style="display: none; margin-top: 4px">
                                                <input type="text" id="vp-style-custom-input-${idx}" placeholder="e.g. Raspy, Operatic, Soulful..." onkeydown="if (event.key === 'Enter') confirmCustomTag('vp-style-${idx}', 'vp-style-custom-input-${idx}', 'vp-style-custom-input-row-${idx}');" />
                                                <button class="custom-input-confirm" onclick="confirmCustomTag('vp-style-${idx}', 'vp-style-custom-input-${idx}', 'vp-style-custom-input-row-${idx}')">Add</button>
                                                <button class="custom-input-cancel" onclick="hideCustomInput('vp-style-custom-input-row-${idx}', 'vp-style-custom-input-${idx}')">x</button>
                                            </div>
                                        </div>
                                    `;
                    container.appendChild(profileDiv);
                });

                // Setup tag click handlers
                container.querySelectorAll(".tag.multi").forEach((tag) => {
                    tag.addEventListener("click", () => tag.classList.toggle("active"));
                });

                // Setup gender change handlers to update range options
                container.querySelectorAll(".vp-gender").forEach((select) => {
                    select.addEventListener("change", (e) => {
                        const idx = e.target.dataset.idx;
                        const gender = e.target.value;
                        const rangeSelect = container.querySelector(`.vp-range[data-idx="${idx}"]`);
                        let options = '<option value="">Not specified</option>';
                        if (gender === "Male") {
                            options += `
                                                <option value="Bass">Bass</option>
                                                <option value="Baritone">Baritone</option>
                                                <option value="Tenor">Tenor</option>
                                                <option value="Countertenor">Countertenor</option>
                                            `;
                        }
                        if (gender === "Female") {
                            options += `
                                                <option value="Contralto">Contralto</option>
                                                <option value="Mezzo-Soprano">Mezzo-Soprano</option>
                                                <option value="Soprano">Soprano</option>
                                            `;
                        }
                        options += '<option value="__custom__">+ Custom Range...</option>';
                        rangeSelect.innerHTML = options;
                    });
                });

                // Setup range change handlers to show custom input
                container.querySelectorAll(".vp-range").forEach((select) => {
                    select.addEventListener("change", (e) => {
                        const idx = e.target.dataset.idx;
                        if (e.target.value === "__custom__") {
                            showCustomRangeInput(idx);
                        } else {
                            hideCustomRangeInput(idx);
                        }
                    });
                });
            }

            function getVocalProfiles() {
                const vocalType = document.querySelector("#vocal-type-tags .tag.active")?.dataset.val || "Single Male";
                const container = document.getElementById("vocal-profiles-container");
                const profiles = [];

                container.querySelectorAll(".vocal-profile-builder").forEach((builder, idx) => {
                    const gender = builder.querySelector(`.vp-gender[data-idx="${idx}"]`)?.value || "";
                    const range = builder.querySelector(`.vp-range[data-idx="${idx}"]`)?.value || "";

                    const accentContainer = builder.querySelector(`#vp-accent-${idx}`);
                    const accents = accentContainer ? [...accentContainer.querySelectorAll(".tag.active, .tag-custom")].map((t) => t.dataset.val).filter(Boolean) : [];

                    const styleTagsContainer = builder.querySelector(`#vp-style-${idx}`);
                    const styles = styleTagsContainer ? [...styleTagsContainer.querySelectorAll(".tag.active, .tag-custom")].map((t) => t.dataset.val).filter(Boolean) : [];

                    const profile = { gender };
                    if (accents.length) profile.accents = accents;
                    if (range) profile.range = range;
                    if (styles.length) profile.styles = styles;

                    profiles.push(profile);
                });

                const choir = getChoirConfig();

                return { type: vocalType, profiles, choir };
            }

            function formatVocalProfilesForPrompt(vocalData) {
                if (!vocalData || vocalData.type === "Instrumental") {
                    return "Instrumental (no vocals)";
                }
                if (vocalData.type === "Choir/Ensemble") {
                    if (!vocalData.choir) return "Choir/Ensemble";
                    const choirParts = [`Choir/Ensemble: ${vocalData.choir.gender}`, vocalData.choir.size];
                    if (vocalData.choir.ranges && vocalData.choir.ranges.length) choirParts.push(`ranges: ${vocalData.choir.ranges.join(", ")}`);
                    if (vocalData.choir.accents && vocalData.choir.accents.length) choirParts.push(`${vocalData.choir.accents.join("/")} accent`);
                    if (vocalData.choir.styles && vocalData.choir.styles.length) choirParts.push(vocalData.choir.styles.join(", "));
                    return choirParts.join(", ");
                }
                if (!vocalData.profiles || vocalData.profiles.length === 0) {
                    return "Not specified";
                }

                const parts = [];

                // Format lead vocals
                vocalData.profiles.forEach((profile, idx) => {
                    const profileParts = [profile.gender];
                    if (profile.accents && profile.accents.length) profileParts.push(`${profile.accents.join("/")} accent`);
                    if (profile.range) profileParts.push(profile.range);
                    if (profile.styles && profile.styles.length) profileParts.push(profile.styles.join(", "));

                    const label = vocalData.profiles.length > 1 ? `Voice ${idx + 1}: ` : "";
                    parts.push(label + profileParts.join(", "));
                });

                // Add choir if present
                if (vocalData.choir) {
                    const choirParts = [`Choir: ${vocalData.choir.gender}`, vocalData.choir.size];
                    if (vocalData.choir.ranges && vocalData.choir.ranges.length) {
                        choirParts.push(`ranges: ${vocalData.choir.ranges.join(", ")}`);
                    }
                    if (vocalData.choir.accents && vocalData.choir.accents.length) {
                        choirParts.push(`${vocalData.choir.accents.join("/")} accent`);
                    }
                    parts.push(choirParts.join(", "));
                }

                return parts.join(" | ");
            }

            function getSelectedAccent() {
                // Legacy compatibility
                return document.getElementById("accent-select")?.value || "Default";
            }
            function getSelectedVocalRange() {
                // Legacy compatibility
                return document.getElementById("vocal-range-select")?.value || "Auto";
            }
            function getSelectedTempoPreference() {
                const mode = document.getElementById("tempo-mode")?.value || "ai";
                if (mode !== "custom") return "AI Choose";
                return formatTempoPreference(getTempoPreference());
            }
            function getSelectedVerseLength() {
                return document.getElementById("verse-length-select")?.value || "";
            }
            function getSelectedChorusLength() {
                return document.getElementById("chorus-length-select")?.value || "";
            }
            function normalizeVocalGenderValues(value) {
                // Legacy compatibility - kept for loading old songs
                if (Array.isArray(value)) {
                    return [...new Set(value.map((v) => String(v || "").trim()).filter(Boolean))];
                }
                if (typeof value === "string") {
                    return [
                        ...new Set(
                            value
                                .split(/[;,]/)
                                .map((v) => v.trim())
                                .filter(Boolean),
                        ),
                    ];
                }
                return [];
            }
            function formatVocalGenderValue(value) {
                // Legacy compatibility - kept for displaying old songs
                const values = normalizeVocalGenderValues(value);
                return values.length ? values.join(", ") : "Not specified";
            }
            function getSelectedVocalGenderValues() {
                // Use new vocal profile system
                const vocalData = getVocalProfiles();
                return [vocalData.type]; // Return type for backward compatibility
            }
            function getSelectedVocalGender() {
                // Use new vocal profile system
                return formatVocalProfilesForPrompt(getVocalProfiles());
            }
            function getInstrumentExclusions() {
                return document.getElementById("instrument-exclude")?.value?.trim() || "";
            }
            function getActiveMulti(id) {
                const c = document.getElementById(id);
                const preset = [...c.querySelectorAll(".tag.active")].map((t) => t.dataset.val).filter(Boolean);
                const custom = [...c.querySelectorAll(".tag-custom")].map((t) => t.dataset.val).filter(Boolean);
                return [...preset, ...custom];
            }
            function getActiveGenre() {
                // Use the new genre selector system
                return getSelectedGenreLabel();
            }
            function clearCustomRhyme() {
                clearCustomSingleValue("rhyme-custom-row", "rhyme-custom-tag");
            }
            function applyRhymeSetting(rhymeValue) {
                const value = (rhymeValue || "").trim();
                if (!value) return;
                let matched = false;
                document
                    .getElementById("rhyme-tags")
                    .querySelectorAll(".tag")
                    .forEach((t) => {
                        const isMatch = t.dataset.val?.toLowerCase() === value.toLowerCase();
                        t.classList.toggle("active", isMatch);
                        if (isMatch) matched = true;
                    });
                if (matched) {
                    clearCustomRhyme();
                    return;
                }
                setCustomSingleValue("rhyme-custom-row", "rhyme-custom-tag", "Custom rhyme", value);
            }
            function clearAnalyzerCustomTags(tagRowId) {
                const tagRow = document.getElementById(tagRowId);
                if (!tagRow) return;
                tagRow.querySelectorAll('.tag-custom[data-analyzer-custom="true"]').forEach((el) => el.remove());
            }
            function addCustomTagToRow(tagRowId, value, options = {}) {
                const tagRow = document.getElementById(tagRowId);
                if (!tagRow || !value) return;
                const trimmed = value.trim();
                if (!trimmed) return;
                const existing = [...tagRow.querySelectorAll(".tag-custom")].find((t) => (t.dataset.val || "").trim().toLowerCase() === trimmed.toLowerCase());
                if (existing) {
                    if (options.analyzerCustom) existing.dataset.analyzerCustom = "true";
                    return;
                }
                const chip = document.createElement("div");
                chip.className = "tag-custom";
                chip.dataset.val = trimmed;
                chip.dataset.custom = "true";
                if (options.analyzerCustom) chip.dataset.analyzerCustom = "true";
                chip.innerHTML = escapeHtml(trimmed) + '<span class="tag-custom-x" onclick="removeCustomTag(this)">x</span>';
                const addBtn = tagRow.querySelector(".tag-add-btn");
                if (addBtn) tagRow.insertBefore(chip, addBtn);
                else tagRow.appendChild(chip);
            }
            function optionMatchesPreset(optionText, requestedValue) {
                const option = (optionText || "").trim().toLowerCase();
                const requested = (requestedValue || "").trim().toLowerCase();
                if (!option || !requested) return false;
                const optionShort = option.split(" - ")[0].trim();
                return option === requested || option.startsWith(requested) || requested.startsWith(optionShort) || option.includes(requested) || requested.includes(optionShort);
            }
            function applyMultiTagValues(tagRowId, values) {
                const tagRow = document.getElementById(tagRowId);
                if (!tagRow) return;
                const normalizedValues = [...new Set((values || []).map((v) => String(v || "").trim()).filter(Boolean))];
                tagRow.querySelectorAll(".tag").forEach((t) => t.classList.remove("active"));
                clearAnalyzerCustomTags(tagRowId);
                normalizedValues.forEach((value) => {
                    let matched = false;
                    tagRow.querySelectorAll(".tag.multi").forEach((t) => {
                        if (optionMatchesPreset(t.dataset.val, value)) {
                            t.classList.add("active");
                            matched = true;
                        }
                    });
                    if (!matched) addCustomTagToRow(tagRowId, value, { analyzerCustom: true });
                });
            }
            function applyGenreSetting(genreKey, genreLabel) {
                // Parse the genre label to extract genre/sub-genre combinations
                // Format could be "Rock: Classic Rock" or "Rock: Classic Rock + Jazz: Bebop"
                selectedGenres = [];

                if (genreLabel && genreLabel.includes(":")) {
                    // Parse format like "Rock: Classic Rock + Jazz: Bebop"
                    const parts = genreLabel.split("+").map((p) => p.trim());
                    parts.forEach((part) => {
                        const colonIdx = part.indexOf(":");
                        if (colonIdx === -1) return;
                        const mainName = part.slice(0, colonIdx).trim();
                        const subName = part.slice(colonIdx + 1).trim();
                        if (!mainName || !subName) return;

                        // Find the genre in metadata
                        const mainGenre = GENRE_METADATA.find((g) => g.name.toLowerCase() === mainName.toLowerCase());
                        if (mainGenre) {
                            // Known main genre — try to match sub-genre, fall back to custom sub
                            const subGenre = mainGenre.subOptions.find((s) => s.name.toLowerCase() === subName.toLowerCase());
                            if (subGenre) {
                                selectedGenres.push({
                                    mainGenre: mainGenre.name,
                                    subGenre: subGenre.name,
                                    mainId: mainGenre.id,
                                    subId: subGenre.id,
                                });
                            } else {
                                // Sub-genre not in preset list — keep as custom sub under this main genre
                                selectedGenres.push({
                                    mainGenre: mainGenre.name,
                                    subGenre: subName,
                                    mainId: mainGenre.id,
                                    subId: "custom_" + Date.now(),
                                });
                            }
                        } else {
                            // Main genre not found (e.g. "Custom") — store as a custom entry
                            selectedGenres.push({
                                mainGenre: mainName,
                                subGenre: subName,
                                mainId: "custom",
                                subId: "custom_" + Date.now(),
                            });
                        }
                    });
                } else if (genreLabel) {
                    // Try to match as custom genre
                    selectedGenres.push({
                        mainGenre: "Custom",
                        subGenre: genreLabel,
                        mainId: "custom",
                        subId: "custom_" + Date.now(),
                    });
                } else if (genreKey) {
                    // Fall back to genre key
                    const normalizedKey = normalizeGenreKey(genreKey);
                    const mainGenre = GENRE_METADATA.find((g) => g.id === normalizedKey);
                    if (mainGenre && mainGenre.subOptions.length > 0) {
                        selectedGenres.push({
                            mainGenre: mainGenre.name,
                            subGenre: mainGenre.subOptions[0].name,
                            mainId: mainGenre.id,
                            subId: mainGenre.subOptions[0].id,
                        });
                    }
                }

                // If nothing matched, ensure at least one genre is selected
                if (selectedGenres.length === 0) {
                    const rockGenre = GENRE_METADATA.find((g) => g.id === "rock");
                    if (rockGenre && rockGenre.subOptions.length > 0) {
                        selectedGenres.push({
                            mainGenre: rockGenre.name,
                            subGenre: rockGenre.subOptions[0].name,
                            mainId: rockGenre.id,
                            subId: rockGenre.subOptions[0].id,
                        });
                    }
                }

                updateSelectedGenresDisplay();
                updateCurrentGenreKey();

                // Update custom structure genreKey and preserve selection for lyrics, builder, and history sources
                if (customStructureOption && ["lyrics", "builder", "history"].includes(customStructureOption.source)) {
                    customStructureOption.genreKey = currentGenreKey;
                }

                // Re-select custom structure after rebuilding list
                if (customStructureOption && ["lyrics", "builder", "history"].includes(customStructureOption.source)) {
                    const firstOption = document.querySelector(".struct-opt");
                    if (firstOption) {
                        document.querySelectorAll(".struct-opt").forEach((x) => x.classList.remove("active"));
                        firstOption.classList.add("active");
                    }
                    selectedStructure = customStructureOption;
                }
            }

            // ========================================================================
            // Vocal Configuration Application
            // ========================================================================
            function applyVocalConfiguration(vocalConfig) {
                if (!vocalConfig || !vocalConfig.type) return;

                // Select the vocal type
                const vocalTypeTags = document.querySelectorAll("#vocal-type-tags .tag");
                vocalTypeTags.forEach((tag) => {
                    tag.classList.remove("active");
                    if (tag.dataset.val === vocalConfig.type) {
                        tag.classList.add("active");
                        selectVocalType(tag);
                    }
                });

                // If instrumental, we're done
                if (vocalConfig.type === "Instrumental") return;

                // Apply profiles if provided
                if (vocalConfig.profiles && vocalConfig.profiles.length > 0) {
                    // Wait for vocal profiles to build
                    setTimeout(() => {
                        const profileBuilders = document.querySelectorAll(".vocal-profile-builder");

                        vocalConfig.profiles.forEach((profile, idx) => {
                            if (idx >= profileBuilders.length) return;
                            const builder = profileBuilders[idx];

                            // Set gender
                            const genderSelect = builder.querySelector(`.vp-gender[data-idx="${idx}"]`);
                            if (genderSelect && profile.gender) {
                                genderSelect.value = profile.gender;
                                // Trigger change to update range options
                                genderSelect.dispatchEvent(new Event("change"));
                            }

                            // Set range after gender change has time to update options
                            setTimeout(() => {
                                const rangeSelect = builder.querySelector(`.vp-range[data-idx="${idx}"]`);
                                if (rangeSelect && profile.range) {
                                    // Check if this range value exists in the options
                                    if (!rangeSelect.querySelector(`option[value="${escapeAttr(profile.range)}"]`)) {
                                        // It's a custom range - add it as an option
                                        const customOption = document.createElement("option");
                                        customOption.value = profile.range;
                                        customOption.textContent = profile.range;
                                        // Insert before the "+ Custom Range..." option
                                        const customMarker = rangeSelect.querySelector('option[value="__custom__"]');
                                        rangeSelect.insertBefore(customOption, customMarker);
                                    }
                                    rangeSelect.value = profile.range;
                                }
                            }, 50);

                            // Set accents
                            if (profile.accents && profile.accents.length > 0) {
                                const accentContainer = builder.querySelector(`#vp-accent-${idx}`);
                                if (accentContainer) {
                                    // Clear existing custom accents
                                    accentContainer.querySelectorAll(".tag-custom").forEach((el) => el.remove());

                                    profile.accents.forEach((accent) => {
                                        // Try to match preset
                                        const presetTag = accentContainer.querySelector(`.tag[data-val="${accent}"]`);
                                        if (presetTag) {
                                            presetTag.classList.add("active");
                                        } else {
                                            // Add as custom
                                            addCustomTagToRow(`vp-accent-${idx}`, accent);
                                        }
                                    });
                                }
                            }

                            // Set styles
                            if (profile.styles && profile.styles.length > 0) {
                                const styleContainer = builder.querySelector(`#vp-style-${idx}`);
                                if (styleContainer) {
                                    // Clear existing custom styles
                                    styleContainer.querySelectorAll(".tag-custom").forEach((el) => el.remove());

                                    profile.styles.forEach((style) => {
                                        // Try to match preset
                                        const styleTag = styleContainer.querySelector(`.tag[data-val="${style}"]`);
                                        if (styleTag) {
                                            styleTag.classList.add("active");
                                        } else {
                                            // Add as custom
                                            addCustomTagToRow(`vp-style-${idx}`, style);
                                        }
                                    });
                                }
                            }
                        });
                    }, 100);
                }

                // Apply choir configuration if provided
                if (vocalConfig.choir && (vocalConfig.choir.enabled || vocalConfig.type === "Choir/Ensemble")) {
                    if (vocalConfig.type !== "Choir/Ensemble") {
                        // For non-ensemble types, enable the backing choir checkbox
                        const choirCheckbox = document.getElementById("choir-enabled");
                        if (choirCheckbox) {
                            choirCheckbox.checked = true;
                            toggleChoir(true);
                        }
                    }
                    // Choir/Ensemble: builder already shown by selectVocalType above
                    setTimeout(() => {
                        if (vocalConfig.choir.gender) {
                            const genderSelect = document.getElementById("choir-gender");
                            if (genderSelect) genderSelect.value = vocalConfig.choir.gender;
                        }

                        if (vocalConfig.choir.size) {
                            const sizeSelect = document.getElementById("choir-size");
                            if (sizeSelect) sizeSelect.value = vocalConfig.choir.size;
                        }

                        if (vocalConfig.choir.ranges && vocalConfig.choir.ranges.length > 0) {
                            const rangeContainer = document.getElementById("choir-range-tags");
                            if (rangeContainer) {
                                vocalConfig.choir.ranges.forEach((range) => {
                                    const rangeTag = rangeContainer.querySelector(`.tag[data-val="${range}"]`);
                                    if (rangeTag) rangeTag.classList.add("active");
                                });
                            }
                        }

                        if (vocalConfig.choir.accents && vocalConfig.choir.accents.length > 0) {
                            const accentContainer = document.getElementById("choir-accent-tags");
                            if (accentContainer) {
                                accentContainer.querySelectorAll(".tag-custom").forEach((el) => el.remove());
                                vocalConfig.choir.accents.forEach((accent) => {
                                    const presetTag = accentContainer.querySelector(`.tag[data-val="${accent}"]`);
                                    if (presetTag) {
                                        presetTag.classList.add("active");
                                    } else {
                                        addCustomTagToRow("choir-accent-tags", accent);
                                    }
                                });
                            }
                        }

                        if (vocalConfig.choir.styles && vocalConfig.choir.styles.length > 0) {
                            const styleContainer = document.getElementById("choir-style-tags");
                            if (styleContainer) {
                                styleContainer.querySelectorAll(".tag-custom").forEach((el) => el.remove());
                                vocalConfig.choir.styles.forEach((style) => {
                                    const presetTag = styleContainer.querySelector(`.tag[data-val="${style}"]`);
                                    if (presetTag) {
                                        presetTag.classList.add("active");
                                    } else {
                                        addCustomTagToRow("choir-style-tags", style);
                                    }
                                });
                            }
                        }
                    }, 150);
                }
            }

            // ========================================================================
            // Influences
            // Manages artist influences and musical reference points
            // ========================================================================
            function addInfluence() {
                const inp = document.getElementById("influence-input");
                const val = inp.value.trim();
                if (!val) return;
                addInfluenceVal(val);
                inp.value = "";
            }
            function addInfluenceVal(val) {
                if (influences.includes(val)) return;
                influences.push(val);
                renderInfluenceChips();
                // Auto-check the influences checkbox when user adds an influence
                const checkbox = document.getElementById("enable-influences-checkbox");
                if (checkbox && !checkbox.checked) {
                    checkbox.checked = true;
                }
            }
            function removeInfluence(val) {
                influences = influences.filter((x) => x !== val);
                document
                    .getElementById("inf-suggest-tags")
                    .querySelectorAll(".tag")
                    .forEach((t) => {
                        if (t.dataset.inf === val) t.classList.remove("active");
                    });
                renderInfluenceChips();
            }
            function renderInfluenceChips() {
                document.getElementById("influence-chips").innerHTML = influences.map((v) => `<div class="inf-chip"><span>${escapeHtml(v)}</span><span class="inf-chip-x" onclick="removeInfluence('${escapeAttr(v).replace(/'/g, "\\'")}')">x</span></div>`).join("");
            }

            // ========================================================================
            // Structure
            // Manages song structure definitions, custom sequences, and chord progressions
            // ========================================================================
            function getStructuresForGenre(genreKey) {
                const presets = GENRE_STRUCTURES[genreKey] || DEFAULT_STRUCTURES;
                if (customStructureOption && customStructureOption.genreKey === genreKey) {
                    return [customStructureOption, ...presets];
                }
                return presets;
            }
            function structureFlowFromSequence(sequence) {
                return (sequence || [])
                    .map((step) => {
                        if (typeof step === "object" && step.name) {
                            return step.chords ? `${step.name} (${step.chords})` : step.name;
                        }
                        return String(step || "").trim();
                    })
                    .filter(Boolean)
                    .join(" -> ");
            }
            function parseStructureFlow(flow) {
                return String(flow || "")
                    .split(/\s*->\s*/)
                    .map((step) => {
                        step = step.trim();
                        // Parse "SectionName (Chords)" format
                        const match = step.match(/^(.+?)\s*\(([^)]+)\)$/);
                        if (match) {
                            return { name: match[1].trim(), chords: match[2].trim(), instructions: "" };
                        }
                        return { name: step, chords: "", instructions: "" };
                    })
                    .filter(Boolean);
            }
            function suggestCustomStructureDescription(sequence) {
                const steps = (sequence || []).map((s) => (typeof s === "object" ? s.name : s)).filter(Boolean);
                if (!steps.length) return "Built from scratch in the custom structure builder.";
                if (steps.length === 1) return `Single-section form centered on ${steps[0]}.`;
                return `Custom-built form that moves through ${steps.slice(0, -1).join(", ")}, and resolves with ${steps[steps.length - 1]}.`;
            }
            function syncCustomStructureBuilderFields(structureData = null) {
                const nameInput = document.getElementById("custom-structure-name");
                const tagInput = document.getElementById("custom-structure-tag");
                const descInput = document.getElementById("custom-structure-desc");
                const pointInput = document.getElementById("custom-structure-point-input");
                if (!nameInput || !tagInput || !descInput) return;
                if (!structureData) {
                    nameInput.value = "";
                    tagInput.value = "";
                    descInput.value = "";
                    if (pointInput) pointInput.value = "";
                    customStructureDraft = [];
                    customStructurePoints = [];
                    renderCustomStructureDraft();
                    renderStructureBuilderPalette();
                    return;
                }
                nameInput.value = structureData.name || "";
                tagInput.value = structureData.tag || "";
                descInput.value = structureData.desc || "";
                customStructureDraft = Array.isArray(structureData.sequence) && structureData.sequence.length ? [...structureData.sequence] : parseStructureFlow(structureData.flow);
                renderCustomStructureDraft();
            }
            function hasLyricsCustomStructure() {
                return !!(customStructureOption && customStructureOption.source === "lyrics");
            }
            function clearCustomStructure(genreKey = currentGenreKey) {
                if (!customStructureOption) return;
                if (!genreKey || customStructureOption.genreKey === genreKey) customStructureOption = null;
            }
            function renderStructureBuilderPalette() {
                const palette = document.getElementById("structure-builder-palette");
                if (!palette) return;
                const allPoints = [...CUSTOM_STRUCTURE_POINTS, ...customStructurePoints];
                palette.innerHTML = allPoints.map((step) => `<button class="struct-builder-tag" type="button" onclick="addStructurePoint('${escapeAttr(step).replace(/'/g, "\\'")}')">+ ${escapeHtml(step)}</button>`).join("");
            }
            function addCustomStructureBlock() {
                const input = document.getElementById("custom-structure-point-input");
                const value = input?.value?.trim();
                if (!value) return;
                if (customStructurePoints.includes(value) || CUSTOM_STRUCTURE_POINTS.includes(value)) {
                    input.value = "";
                    return;
                }
                customStructurePoints.push(value);
                input.value = "";
                renderStructureBuilderPalette();
            }
            function renderCustomStructureDraft() {
                const sequenceEl = document.getElementById("custom-structure-sequence");
                const flowEl = document.getElementById("custom-structure-flow-preview");
                if (!sequenceEl || !flowEl) return;
                if (!customStructureDraft.length) {
                    sequenceEl.innerHTML = `<div class="custom-structure-empty">No custom steps yet. Click a structure block above to start building your flow.</div>`;
                    flowEl.textContent = _t("empty.no_steps", "No custom steps yet.");
                    return;
                }
                flowEl.textContent = structureFlowFromSequence(customStructureDraft);
                sequenceEl.innerHTML = customStructureDraft
                    .map((step, idx) => {
                        const stepName = typeof step === "object" ? step.name : step;
                        const stepChords = typeof step === "object" ? step.chords || "" : "";
                        const stepInstructions = typeof step === "object" ? step.instructions || "" : "";
                        return `<div class="custom-structure-step">
                                                <div class="custom-structure-step-header">
                                                    <span class="custom-structure-step-label">${idx + 1}.</span>
                                                    <span style="flex:1">${escapeHtml(stepName)}</span>
                                                    <button class="custom-structure-step-btn" type="button" onclick="moveCustomStructurePoint(${idx},-1)">←</button>
                                                    <button class="custom-structure-step-btn" type="button" onclick="moveCustomStructurePoint(${idx},1)">→</button>
                                                    <button class="custom-structure-step-btn" type="button" onclick="removeCustomStructurePoint(${idx})">x</button>
                                                </div>
                                                <div class="custom-structure-step-chords">
                                                       <input type="text" name="custom-step-chords-${idx}" placeholder="Chords (e.g., Em-C-G-D)" value="${escapeAttr(stepChords)}"
                                                           onchange="updateStructureStepChords(${idx}, this.value)"
                                                           onclick="event.stopPropagation()" />
                                                </div>
                                                <div class="custom-structure-step-instructions">
                                                       <input type="text" name="custom-step-instructions-${idx}" placeholder="Section instructions (e.g., whispered, building intensity)" value="${escapeAttr(stepInstructions)}"
                                                           onchange="updateStructureStepInstructions(${idx}, this.value)"
                                                           onclick="event.stopPropagation()" />
                                                </div>
                                            </div>`;
                    })
                    .join("");
            }
            function addStructurePoint(step) {
                const value = String(step || "").trim();
                if (!value) return;
                customStructureDraft.push({ name: value, chords: "", instructions: "" });
                renderCustomStructureDraft();
            }
            function updateStructureStepChords(idx, chords) {
                if (idx < 0 || idx >= customStructureDraft.length) return;
                const step = customStructureDraft[idx];
                if (typeof step === "object") {
                    step.chords = chords.trim();
                } else {
                    customStructureDraft[idx] = { name: step, chords: chords.trim(), instructions: "" };
                }
                renderCustomStructureDraft();
            }
            function updateStructureStepInstructions(idx, instructions) {
                if (idx < 0 || idx >= customStructureDraft.length) return;
                const step = customStructureDraft[idx];
                if (typeof step === "object") {
                    step.instructions = instructions.trim();
                } else {
                    customStructureDraft[idx] = { name: step, chords: "", instructions: instructions.trim() };
                }
                renderCustomStructureDraft();
            }
            function moveCustomStructurePoint(idx, direction) {
                const nextIndex = idx + direction;
                if (idx < 0 || idx >= customStructureDraft.length || nextIndex < 0 || nextIndex >= customStructureDraft.length) return;
                const [item] = customStructureDraft.splice(idx, 1);
                customStructureDraft.splice(nextIndex, 0, item);
                renderCustomStructureDraft();
            }
            function removeCustomStructurePoint(idx) {
                if (idx < 0 || idx >= customStructureDraft.length) return;
                customStructureDraft.splice(idx, 1);
                renderCustomStructureDraft();
            }
            function undoCustomStructurePoint() {
                if (!customStructureDraft.length) return;
                customStructureDraft.pop();
                renderCustomStructureDraft();
            }
            function clearCustomStructureBuilder() {
                const shouldResetCustomOption = customStructureOption && customStructureOption.source === "builder";
                syncCustomStructureBuilderFields(null);
                if (shouldResetCustomOption) {
                    customStructureOption = null;
                    buildStructureList(currentGenreKey);
                }
            }
            function applyCustomStructureBuilder(sourceOverride = null) {
                if (!customStructureDraft.length) {
                    alert(_t("alert.no_struct_points", "Add at least one structure point first."));
                    return;
                }
                const name = document.getElementById("custom-structure-name").value.trim() || "Custom Structure";
                const tag = document.getElementById("custom-structure-tag").value.trim() || "Builder";
                const desc = document.getElementById("custom-structure-desc").value.trim() || suggestCustomStructureDescription(customStructureDraft);
                customStructureOption = {
                    genreKey: currentGenreKey,
                    source: sourceOverride || "builder",
                    name,
                    tag,
                    flow: structureFlowFromSequence(customStructureDraft),
                    desc,
                    sequence: [...customStructureDraft],
                };
                buildStructureList(currentGenreKey);
                activateStructureIndex(currentGenreKey, 0);
            }
            function buildStructureList(genreKey) {
                const list = document.getElementById("structure-list");
                if (!list) return; // Element doesn't exist yet during early initialization

                // Collect unique main genre keys in selection order
                const uniqueGenres = [];
                const seenKeys = new Set();
                if (selectedGenres.length > 0) {
                    selectedGenres.forEach((g) => {
                        const key = normalizeGenreKey(g.mainId);
                        if (!seenKeys.has(key)) {
                            seenKeys.add(key);
                            uniqueGenres.push({ key, name: g.mainGenre });
                        }
                    });
                } else {
                    // Fallback to the provided genreKey
                    const meta = GENRE_METADATA.find((g) => g.id === genreKey);
                    uniqueGenres.push({ key: genreKey, name: meta ? meta.name : genreKey || "Rock" });
                }

                // Update label to reflect all selected genres
                const labelEl = document.getElementById("struct-genre-label");
                if (labelEl) labelEl.textContent = uniqueGenres.map((g) => g.name).join(" + ");

                const showHeaders = uniqueGenres.length > 1;
                let html = "";
                let isFirst = true;

                uniqueGenres.forEach(({ key, name }) => {
                    const structs = getStructuresForGenre(key);
                    if (showHeaders) {
                        html += `<div class="struct-genre-header">${escapeHtml(name)}</div>`;
                    }
                    structs.forEach((s, i) => {
                        html += `<div class="struct-opt${isFirst ? " active" : ""}" data-genre-key="${escapeAttr(key)}" data-idx="${i}" onclick="selectStructure(this,${i},'${escapeAttr(key)}')">
                      <div class="struct-tag">${escapeHtml(s.tag)}</div>
                      <div class="struct-name">${escapeHtml(s.name)}</div>
                      <div class="struct-flow">${escapeHtml(s.flow)}</div>
                      <div class="struct-desc">${escapeHtml(s.desc)}</div>
                    </div>`;
                        isFirst = false;
                    });
                });

                list.innerHTML = html;
                selectedStructure = getStructuresForGenre(uniqueGenres[0].key)[0];
            }
            function selectStructure(el, idx, genreKey) {
                document.querySelectorAll(".struct-opt").forEach((x) => x.classList.remove("active"));
                el.classList.add("active");
                selectedStructure = getStructuresForGenre(genreKey)[idx];
            }
            function activateStructureIndex(genreKey, idx) {
                const target = document.querySelector(`.struct-opt[data-genre-key="${genreKey}"][data-idx="${idx}"]`);
                if (target) {
                    selectStructure(target, idx, genreKey);
                } else {
                    // Fallback: activate first option
                    const first = document.querySelector(".struct-opt");
                    if (first) {
                        const fKey = first.dataset.genreKey || genreKey;
                        const fIdx = parseInt(first.dataset.idx || "0", 10);
                        selectStructure(first, fIdx, fKey);
                    }
                }
            }
            function findMatchingStructureIndex(genreKey, structureName, structureFlow) {
                const structs = GENRE_STRUCTURES[genreKey] || DEFAULT_STRUCTURES;
                const normalizedName = (structureName || "").trim().toLowerCase();
                const normalizedFlow = (structureFlow || "").trim().toLowerCase();
                return structs.findIndex((s) => {
                    const sameName = normalizedName && (s.name || "").trim().toLowerCase() === normalizedName;
                    const sameFlow = normalizedFlow && (s.flow || "").trim().toLowerCase() === normalizedFlow;
                    return sameName || sameFlow;
                });
            }
            function applyAnalyzedStructure(structureData, genreKey = currentGenreKey) {
                const name = structureData?.name?.trim();
                const flow = structureData?.flow?.trim();
                const desc = structureData?.desc?.trim();
                const tag = structureData?.tag?.trim() || "Custom";

                if (!name && !flow) {
                    clearCustomStructure(genreKey);
                    buildStructureList(genreKey);
                    activateStructureIndex(genreKey, 0);
                    return;
                }

                const presetIndex = findMatchingStructureIndex(genreKey, name, flow);
                if (presetIndex >= 0) {
                    clearCustomStructure(genreKey);
                    buildStructureList(genreKey);
                    activateStructureIndex(genreKey, presetIndex);
                    return;
                }

                const structDataForSync = {
                    genreKey,
                    source: "lyrics",
                    name: name || "Custom Structure",
                    tag,
                    flow: flow || "Custom flow",
                    desc: desc || "Detected from supplied lyrics.",
                };

                // Sync fields and apply the custom structure
                syncCustomStructureBuilderFields(structDataForSync);
                applyCustomStructureBuilder("lyrics");
            }

            // ========================================================================
            // Tabs
            // ========================================================================
            function switchLTab(tab) {
                debugLog("TAB_CHANGE", `Left tab switched: ${activeLeftTab} -> ${tab}`);
                activeLeftTab = tab;
                ["settings", "vocal", "structure", "sound", "lyrics"].forEach((t) => {
                    document.getElementById("ltab-" + t).classList.toggle("active", t === tab);
                    document.getElementById("lpanel-" + t).style.display = t === tab ? "flex" : "none";
                });
            }
            function switchRTab(tab) {
                debugLog("TAB_CHANGE", `Right tab switched to: ${tab}`);
                ["output", "chords", "history"].forEach((t) => {
                    const el = document.getElementById("tab-" + t);
                    el.style.display = t === tab ? "flex" : "none";
                    if (t === tab) el.style.flexDirection = "column";
                    document.getElementById("rtab-" + t).classList.toggle("active", t === tab);
                });
            }

            // ========================================================================
            // Lyrics Mode
            // ========================================================================
            function setLyricsMode(mode) {
                // Simplified - no longer needed since we only have one input mode
                lyricsMode = "single";
            }
            const SECTION_LABELS = ["Intro", "Verse 1", "Pre-Chorus", "Chorus", "Verse 2", "Bridge", "Outro"];
            const MUSICAL_KEYS = [
                "Auto",
                "C major",
                "C minor",
                "C#/Db major",
                "C#/Db minor",
                "D major",
                "D minor",
                "D#/Eb major",
                "D#/Eb minor",
                "E major",
                "E minor",
                "F major",
                "F minor",
                "F#/Gb major",
                "F#/Gb minor",
                "G major",
                "G minor",
                "G#/Ab major",
                "G#/Ab minor",
                "A major",
                "A minor",
                "A#/Bb major",
                "A#/Bb minor",
                "B major",
                "B minor",
            ];
            const MUSICAL_KEY_ALIASES = {
                "c major": "C major",
                "c minor": "C minor",
                "c# major": "C#/Db major",
                "db major": "C#/Db major",
                "c# minor": "C#/Db minor",
                "db minor": "C#/Db minor",
                "d major": "D major",
                "d minor": "D minor",
                "d# major": "D#/Eb major",
                "eb major": "D#/Eb major",
                "d# minor": "D#/Eb minor",
                "eb minor": "D#/Eb minor",
                "e major": "E major",
                "e minor": "E minor",
                "f major": "F major",
                "f minor": "F minor",
                "f# major": "F#/Gb major",
                "gb major": "F#/Gb major",
                "f# minor": "F#/Gb minor",
                "gb minor": "F#/Gb minor",
                "g major": "G major",
                "g minor": "G minor",
                "g# major": "G#/Ab major",
                "ab major": "G#/Ab major",
                "g# minor": "G#/Ab minor",
                "ab minor": "G#/Ab minor",
                "a major": "A major",
                "a minor": "A minor",
                "a# major": "A#/Bb major",
                "bb major": "A#/Bb major",
                "a# minor": "A#/Bb minor",
                "bb minor": "A#/Bb minor",
                "b major": "B major",
                "b minor": "B minor",
            };

            function getSelectedMusicalKey() {
                return document.getElementById("musical-key")?.value || "Auto";
            }

            function getSelectedTimeSignature() {
                const select = document.getElementById("time-signature");
                const value = select?.value || "4/4";
                if (value === "Custom") {
                    const customInput = document.getElementById("time-signature-custom");
                    const customValue = customInput?.value?.trim();
                    return customValue || "4/4";
                }
                if (value === "Auto") return "Auto";
                return value;
            }

            // Normalize musical key input - handles various formats and aliases
            function normalizeMusicalKey(value) {
                if (!value) return "Auto";
                const cleaned = String(value).trim().replace(/♯/g, "#").replace(/♭/g, "b").replace(/\s+/g, " ");
                const lower = cleaned.toLowerCase();
                if (["auto", "any", "unspecified", "let ai choose", "ai choice"].includes(lower)) return "Auto";
                if (MUSICAL_KEYS.includes(cleaned)) return cleaned;
                return MUSICAL_KEY_ALIASES[lower] || "Auto";
            }

            // Build section input rows dynamically for structured lyric entry
            // Only creates rows if they don't already exist
            function buildSectionRows() {
                const c = document.getElementById("section-rows");
                if (!c || c.children.length > 0) return;
                c.innerHTML = SECTION_LABELS.map(
                    (l, idx) => `
                    <div class="section-lyric-row">
                      <div class="section-lyric-label">${l}<span>optional</span></div>
                      <textarea rows="3" name="section-lyrics-${idx}" placeholder="Leave blank for AI..." data-section="${l}"></textarea>
                    </div>`,
                ).join("");
            }

            // Format lyrics data for AI analysis - converts various formats to plain text
            function formatLyricsForAnalysis(lyricsData) {
                if (!lyricsData) return "";
                if (lyricsData.mode === "bulk") return lyricsData.content;
                return Object.entries(lyricsData.content)
                    .map(([section, text]) => `[${section}]\n${text}`)
                    .join("\n\n");
            }

            // Unified Style & Lyrics Analysis
            async function applyUnifiedAnalysis() {
                const analysisInput = document.getElementById("analysis-input").value.trim();
                const selectedMusicalKey = getSelectedMusicalKey();
                const btn = document.getElementById("unified-analyze-btn");
                const resultEl = document.getElementById("unified-analysis-result");

                if (!analysisInput) {
                    alert("Please enter lyrics, style description, or both.");
                    return;
                }

                // Populate lyrics-input field with the analyzed content (strip [Style] meta tag)
                document.getElementById("lyrics-input").value = stripLeadingStyleMetaTag(analysisInput);

                const lyricsText = analysisInput;
                btn.disabled = true;
                btn.innerHTML = "Analyzing...";
                resultEl.style.display = "none";

                const prompt = `You are a music expert. Analyze this input and extract comprehensive settings for a song generator.

                Input:
                """
                ${lyricsText}
                """

                Current genre context: ${getSelectedGenreLabel()}
                Current musical key preference: "${selectedMusicalKey}"

                IMPORTANT: The input may contain:
                - Lyrics with section markers like [Verse 1], [Chorus], [Bridge]
                - Chord progressions in brackets like [Am - F - C - G] or [C#m – A – E]
                - Performance/production instructions in brackets like [Driving bass, Clean guitar]
                - Style descriptions like "Sound like Radiohead" or "1970s lo-fi production"
                - Or a combination of any of the above

                Parse all elements carefully and extract both lyrical structure details AND style/production details.

                Return ONLY valid JSON (no markdown, no backticks):
                {
                  "genre_key": "one of: rock|metal|folk|country|jazz|blues|rnb|hiphop|gospel|reggae|ska|latin|cumbia; empty string if not strongly implied",
                  "genre_label": "specific genre or subgenre label; not limited to preset UI options; empty string if not applicable",
                  "mood": "specific mood description; not limited to preset UI options; empty string if not strongly implied",
                  "goal": "song purpose/goal like Workout, Meditation, Dance Floor Banger, Background Music, etc.; empty string if not strongly implied",
                  "rhythm": "rhythm style like Syncopated, Swing, Groove-Based, Triplet, etc.; empty string if not strongly implied",
                  "groove_feel": "groove/pocket feel like Funky, Smooth, Driving, Tight, Loose, Bouncy, Laid-back, Groovy, Hypnotic, etc.; empty string if not strongly implied",
                  "bass": "bass style like Deep Sub-Bass, 808 Bass, Warm Bass, Punchy Bass, Synth Bass, etc.; empty string if not strongly implied",
                  "spatial_effects": ["spatial/effects like Reverb-Heavy, Delay Effects, Wide Stereo, Chorus, Flanger, etc.; empty array if not applicable"],
                  "rhyme": "detected rhyme scheme or rhyme style; do not limit this to preset UI choices; empty string if not applicable",
                  "tempo": "AI Choose or a specific BPM / range like 100 BPM or 90-110 BPM; empty string if not strongly implied",
                  "pov": "perspective description; can match presets or be custom; empty string if not strongly implied",
                  "musical_key": "one of exactly: Auto | C major | C minor | C#/Db major | C#/Db minor | D major | D minor | D#/Eb major | D#/Eb minor | E major | E minor | F major | F minor | F#/Gb major | F#/Gb minor | G major | G minor | G#/Ab major | G#/Ab minor | A major | A minor | A#/Bb major | A#/Bb minor | B major | B minor; empty string to keep current",
                  "time_signature": "one of: Auto | 4/4 | 3/4 | 2/4 | 6/8 | 5/4 | 7/4 | 9/8 | 12/8 | or custom like 7/8; empty string if not applicable",
                  "era_keys": ["era/decade labels if detected; preset or custom"],
                  "prodstyle_keys": ["production style labels if detected; preset or custom"],
                  "instruments_keys": ["specific instruments detected like Acoustic Guitar, Electric Piano, Violin, Saxophone, Drums, etc.; empty array if not applicable"],
                  "inst_keys": ["instrumentation labels if detected; preset or custom"],
                  "mix_keys": ["mix-character labels if detected; preset or custom"],
                  "influences": ["up to 3 artist names if style references are detected"],
                  "vocal_config": {
                    "type": "one of: Single Male | Single Female | Male Duo | Female Duo | Male & Female Duo | Choir/Ensemble | Instrumental; omit if not detected",
                    "profiles": [{"gender": "Male or Female", "range": "Bass, Baritone, Tenor, Countertenor, Contralto, Mezzo-Soprano, Soprano", "accents": [], "styles": []}]
                  },
                  "structure_name": "detected song structure name if identifiable from lyrics; otherwise empty string",
                  "structure_flow": "detected section flow like Verse -> Chorus -> Verse -> Chorus -> Bridge -> Chorus if identifiable from lyrics; otherwise empty string",
                  "structure_desc": "short explanation of the detected structure; otherwise empty string",
                  "structure_tag": "short label for the structure such as Ballad, Verse-Heavy, Hook-Driven, etc.; otherwise empty string",
                  "structure_sequence": [
                    {
                      "name": "Section name like Verse 1, Chorus, Bridge",
                      "chords": "chord progression if found in brackets (e.g., 'C#m - A - E' or 'Am - F - C - G'), otherwise empty string",
                      "instructions": "performance/production instructions if found in brackets, otherwise empty string"
                    }
                  ],
                  "summary": "One short sentence describing what was detected and applied"
                }

                For structure_sequence, create one entry for each section found in the lyrics. Extract chords and instructions from the bracketed meta tags.
                If the input appears to be primarily a style description (not lyrics), focus on extracting genre, mood, tempo, era, production, instrumentation, and influences.
                If the input contains lyrics, extract structure details AND any implied style elements.
                If the input contains both explicit style description and lyrics, extract both comprehensively.
                If no musical key is strongly implied by the input, return empty string to keep the current preference.`;

                try {
                    if (!aiClient && activeApiProvider === "google") throw new Error("Google AI key not set — enter your key in the API Key bar.");
                    debugLog("ANALYZER_REQUEST", "Sending analysis request to AI", {
                        inputLength: analysisInput.length,
                        input: analysisInput,
                        promptLength: prompt.length,
                        prompt: prompt,
                    });
                    const response = await callAI(prompt);
                    const raw = response.text.replace(/```json|```/g, "").trim();
                    debugLog("ANALYZER_RESPONSE", "Received analysis from AI", {
                        responseLength: raw.length,
                        rawResponse: raw,
                    });
                    const analysis = safeParseJSON(raw);
                    debugLog("ANALYZER_PARSED", "Parsed analysis result", analysis);
                    // This ensures customStructureOption gets the correct genreKey
                    if (analysis.genre_key || analysis.genre_label) {
                        applyGenreSetting(analysis.genre_key || currentGenreKey || "rock", analysis.genre_label || "");
                    }

                    if (analysis.rhyme) applyRhymeSetting(analysis.rhyme);
                    if (analysis.mood) applySingleTagOrCustom("mood-tags", analysis.mood, "mood-custom-row", "mood-custom-tag", "Custom mood");
                    if (analysis.goal) applySingleTagOrCustom("goal-tags", analysis.goal, "goal-custom-row", "goal-custom-tag", "Custom goal");
                    if (analysis.rhythm) applySingleTagOrCustom("rhythm-tags", analysis.rhythm, "rhythm-custom-row", "rhythm-custom-tag", "Custom rhythm");
                    if (analysis.groove_feel) applySingleTagOrCustom("groove-tags", analysis.groove_feel, "groove-custom-row", "groove-custom-tag", "Custom groove feel");
                    if (analysis.bass) applySingleTagOrCustom("bass-tags", analysis.bass, "bass-custom-row", "bass-custom-tag", "Custom bass");
                    if (analysis.spatial_effects && analysis.spatial_effects.length) applyMultiTagValues("spatial-tags", analysis.spatial_effects);
                    if (analysis.pov) applySingleTagOrCustom("pov-tags", analysis.pov, "pov-custom-row", "pov-custom-tag", "Custom perspective");

                    // Build custom structure with chords and instructions if provided
                    if (analysis.structure_sequence && Array.isArray(analysis.structure_sequence) && analysis.structure_sequence.length > 0) {
                        // Clear and rebuild custom structure draft
                        customStructureDraft = [];
                        analysis.structure_sequence.forEach((section) => {
                            customStructureDraft.push({
                                name: section.name || "Section",
                                chords: section.chords || "",
                                instructions: section.instructions || "",
                            });
                        });

                        // Populate the custom structure builder fields
                        const name = analysis.structure_name || "Analyzed Structure";
                        const tag = analysis.structure_tag || "Analyzed";
                        const desc = analysis.structure_desc || "Detected from supplied lyrics.";
                        const flow = analysis.structure_flow || structureFlowFromSequence(customStructureDraft);

                        const structureData = {
                            genreKey: currentGenreKey,
                            source: "lyrics",
                            name: name,
                            tag: tag,
                            flow: flow,
                            desc: desc,
                            sequence: customStructureDraft,
                        };

                        // Sync fields and apply the custom structure
                        syncCustomStructureBuilderFields(structureData);
                        applyCustomStructureBuilder("lyrics");

                        // Switch to Structure tab to show the analyzed structure
                        switchLTab("structure");
                    } else {
                        // Fallback to basic structure without chords/instructions
                        applyAnalyzedStructure(
                            {
                                name: analysis.structure_name,
                                flow: analysis.structure_flow,
                                desc: analysis.structure_desc,
                                tag: analysis.structure_tag,
                            },
                            currentGenreKey,
                        );

                        // Switch to Structure tab if a structure was identified, otherwise Lyrics tab
                        if (analysis.structure_name || analysis.structure_flow) {
                            switchLTab("structure");
                        } else {
                            switchLTab("lyrics");
                        }
                    }

                    const sectionsWithChords = (analysis.structure_sequence || []).filter((s) => s.chords).length;
                    const sectionsWithInstructions = (analysis.structure_sequence || []).filter((s) => s.instructions).length;

                    // Apply remaining style-related settings (genre was already applied above)
                    if (analysis.tempo) applyTempoPreference(analysis.tempo);
                    if (analysis.musical_key) {
                        document.getElementById("musical-key").value = normalizeMusicalKey(analysis.musical_key);
                    }
                    if (analysis.time_signature) {
                        const timeSignatureSelect = document.getElementById("time-signature");
                        const timeSignatureCustom = document.getElementById("time-signature-custom");
                        const presetOptions = ["Auto", "4/4", "3/4", "2/4", "6/8", "5/4", "7/4", "9/8", "12/8"];
                        if (presetOptions.includes(analysis.time_signature)) {
                            timeSignatureSelect.value = analysis.time_signature;
                        } else {
                            timeSignatureSelect.value = "Custom";
                            timeSignatureCustom.value = analysis.time_signature;
                        }
                        toggleTimeSignatureMode();
                    }
                    if (analysis.vocal_config && analysis.vocal_config.type) {
                        applyVocalConfiguration(analysis.vocal_config);
                    }
                    if (analysis.instrument_exclusions) document.getElementById("instrument-exclude").value = String(analysis.instrument_exclusions || "");
                    if (analysis.era_keys && analysis.era_keys.length) applyMultiTagValues("era-tags", analysis.era_keys);
                    if (analysis.prodstyle_keys && analysis.prodstyle_keys.length) applyMultiTagValues("prodstyle-tags", analysis.prodstyle_keys);
                    if (analysis.instruments_keys && analysis.instruments_keys.length) applyMultiTagValues("instruments-tags", analysis.instruments_keys);
                    if (analysis.inst_keys && analysis.inst_keys.length) applyMultiTagValues("inst-tags", analysis.inst_keys);
                    if (analysis.mix_keys && analysis.mix_keys.length) applyMultiTagValues("mix-tags", analysis.mix_keys);
                    if (analysis.influences && analysis.influences.length) analysis.influences.forEach((inf) => addInfluenceVal(inf));

                    const vocalConfigDisplay = analysis.vocal_config && analysis.vocal_config.type ? `<div class="style-applied-row"><span class="style-applied-key">Vocal Config:</span><span class="style-applied-val">${escapeHtml(analysis.vocal_config.type)}</span></div>` : "";

                    resultEl.style.display = "block";
                    resultEl.innerHTML = `<div class="style-result-box">
                      <span class="style-result-title">${_t("status.analysis_applied", "Analysis Applied")}</span>
                      ${analysis.genre_key || analysis.genre_label ? `<div class="style-applied-row"><span class="style-applied-key">Genre:</span><span class="style-applied-val">${escapeHtml(getSelectedGenreLabel() || analysis.genre_label || analysis.genre_key || "—")}</span></div>` : ""}
                      ${analysis.mood ? `<div class="style-applied-row"><span class="style-applied-key">Mood:</span><span class="style-applied-val">${escapeHtml(analysis.mood)}</span></div>` : ""}
                      ${analysis.goal ? `<div class="style-applied-row"><span class="style-applied-key">Goal:</span><span class="style-applied-val">${escapeHtml(analysis.goal)}</span></div>` : ""}
                      ${analysis.rhythm ? `<div class="style-applied-row"><span class="style-applied-key">Rhythm:</span><span class="style-applied-val">${escapeHtml(analysis.rhythm)}</span></div>` : ""}
                      ${analysis.groove_feel ? `<div class="style-applied-row"><span class="style-applied-key">Groove Feel:</span><span class="style-applied-val">${escapeHtml(analysis.groove_feel)}</span></div>` : ""}
                      ${analysis.bass ? `<div class="style-applied-row"><span class="style-applied-key">Bass:</span><span class="style-applied-val">${escapeHtml(analysis.bass)}</span></div>` : ""}
                      ${analysis.spatial_effects && analysis.spatial_effects.length ? `<div class="style-applied-row"><span class="style-applied-key">Spatial/Effects:</span><span class="style-applied-val">${escapeHtml((analysis.spatial_effects || []).join(", "))}</span></div>` : ""}
                      ${analysis.rhyme ? `<div class="style-applied-row"><span class="style-applied-key">Rhyme:</span><span class="style-applied-val">${escapeHtml(analysis.rhyme)}</span></div>` : ""}
                      ${analysis.pov ? `<div class="style-applied-row"><span class="style-applied-key">Perspective:</span><span class="style-applied-val">${escapeHtml(analysis.pov)}</span></div>` : ""}
                      ${analysis.tempo ? `<div class="style-applied-row"><span class="style-applied-key">Tempo:</span><span class="style-applied-val">${escapeHtml(formatTempoPreference(analysis.tempo))}</span></div>` : ""}
                      ${analysis.musical_key ? `<div class="style-applied-row"><span class="style-applied-key">Key:</span><span class="style-applied-val">${escapeHtml(normalizeMusicalKey(analysis.musical_key))}</span></div>` : ""}
                      ${analysis.time_signature ? `<div class="style-applied-row"><span class="style-applied-key">Time Sig:</span><span class="style-applied-val">${escapeHtml(analysis.time_signature)}</span></div>` : ""}
                      ${analysis.structure_name || selectedStructure ? `<div class="style-applied-row"><span class="style-applied-key">Structure:</span><span class="style-applied-val">${escapeHtml(analysis.structure_name || selectedStructure?.name || "—")}</span></div>` : ""}
                      ${analysis.structure_flow || selectedStructure?.flow ? `<div class="style-applied-row"><span class="style-applied-key">Flow:</span><span class="style-applied-val">${escapeHtml(analysis.structure_flow || selectedStructure?.flow)}</span></div>` : ""}
                      ${sectionsWithChords > 0 ? `<div class="style-applied-row"><span class="style-applied-key">Chords:</span><span class="style-applied-val">${sectionsWithChords} section(s) with progressions</span></div>` : ""}
                      ${sectionsWithInstructions > 0 ? `<div class="style-applied-row"><span class="style-applied-key">Instructions:</span><span class="style-applied-val">${sectionsWithInstructions} section(s) with performance notes</span></div>` : ""}
                      ${analysis.era_keys && analysis.era_keys.length ? `<div class="style-applied-row"><span class="style-applied-key">Era:</span><span class="style-applied-val">${escapeHtml((analysis.era_keys || []).join(", "))}</span></div>` : ""}
                      ${analysis.prodstyle_keys && analysis.prodstyle_keys.length ? `<div class="style-applied-row"><span class="style-applied-key">Production:</span><span class="style-applied-val">${escapeHtml((analysis.prodstyle_keys || []).join(", "))}</span></div>` : ""}
                      ${analysis.instruments_keys && analysis.instruments_keys.length ? `<div class="style-applied-row"><span class="style-applied-key">Instruments:</span><span class="style-applied-val">${escapeHtml((analysis.instruments_keys || []).join(", "))}</span></div>` : ""}
                      ${analysis.inst_keys && analysis.inst_keys.length ? `<div class="style-applied-row"><span class="style-applied-key">Instrumentation:</span><span class="style-applied-val">${escapeHtml((analysis.inst_keys || []).join(", "))}</span></div>` : ""}
                      ${analysis.mix_keys && analysis.mix_keys.length ? `<div class="style-applied-row"><span class="style-applied-key">Mix:</span><span class="style-applied-val">${escapeHtml((analysis.mix_keys || []).join(", "))}</span></div>` : ""}
                      ${vocalConfigDisplay}
                      ${analysis.influences && analysis.influences.length ? `<div class="style-applied-row"><span class="style-applied-key">Influences:</span><span class="style-applied-val">${escapeHtml(analysis.influences.join(", "))}</span></div>` : ""}
                      <div class="style-summary">${escapeHtml(analysis.summary || "")}</div>
                    </div>`;

                    // Set AI mode to "Keep my current lyrics" after successful analysis
                    const aimodeContainer = document.getElementById("aimode-tags");
                    aimodeContainer.querySelectorAll(".tag").forEach((t) => t.classList.remove("active"));
                    const keepTag = aimodeContainer.querySelector('.tag[data-val="keep"]');
                    if (keepTag) keepTag.classList.add("active");
                } catch (err) {
                    resultEl.style.display = "block";
                    resultEl.innerHTML = `<div class="error-box">Analysis failed: ${escapeHtml(err.message)}</div>`;
                }

                btn.disabled = false;
                btn.innerHTML = _t("btn.analyze_for_style", "Analyze for Style and Lyrics");
            }

            // ========================================================================
            // Style Analyzer - Unified lyrics and style analysis
            // ========================================================================
            async function applyStyle() {
                const styleInput = document.getElementById("style-input").value.trim();
                const selectedMusicalKey = getSelectedMusicalKey();
                if (!styleInput) {
                    alert(_t("alert.no_style", "Please describe a style first."));
                    return;
                }
                const btn = document.getElementById("style-apply-btn");
                btn.disabled = true;
                btn.innerHTML = "Analyzing...";
                document.getElementById("style-result").style.display = "none";

                const prompt = `You are master in Suno prompts, music style and theory. Analyze this style description and extract settings for a Suno song generator.

                Style: "${styleInput}"
                Current musical key preference: "${selectedMusicalKey}"

                Return ONLY valid JSON (no markdown, no backticks):
                {
                    "genre_key": "one of: ${getGenreOptionsForAnalyzer()}",
                    "genre_label": "specific genre or subgenre label. Choose from comprehensive list: ${getAllGenreAndSubGenreNames()}. You may also use custom variations not limited to these options.",
                    "mood": "specific mood description; not limited to preset UI options",
                    "rhyme": "specific rhyme scheme or rhyme style; not limited to preset UI options",
                    "tempo": "AI Choose or a specific BPM / range like 100 BPM or 90-110 BPM",
                    "pov": "perspective description; can match presets or be a more specific custom perspective",
                    "musical_key": "one of exactly: Auto | C major | C minor | C#/Db major | C#/Db minor | D major | D minor | D#/Eb major | D#/Eb minor | E major | E minor | F major | F minor | F#/Gb major | F#/Gb minor | G major | G minor | G#/Ab major | G#/Ab minor | A major | A minor | A#/Bb major | A#/Bb minor | B major | B minor",
                    "time_signature": "one of: Auto | 4/4 | 3/4 | 2/4 | 6/8 | 5/4 | 7/4 | 9/8 | 12/8 | or a custom time signature like 7/8 or 13/16",
                    "era_keys": ["one or more era/decade labels; preset or custom"],
                    "prodstyle_keys": ["one or more production style labels; preset or custom"],
                    "inst_keys": ["one or more instrumentation labels; preset or custom"],
                    "mix_keys": ["one or more mix-character labels; preset or custom"],
                    "influences": ["up to 3 artist names"],
                    "vocal_config": {
                        "type": "one of: Single Male | Single Female | Male Duo | Female Duo | Male & Female Duo | Choir/Ensemble | Instrumental",
                        "profiles": [
                            {
                                "gender": "Male or Female",
                                "range": "For Male: Bass, Baritone, Tenor, or Countertenor. For Female: Contralto, Mezzo-Soprano, or Soprano. Optional.",
                                "accents": ["Only specify if NOT American. Options: Australian, British, New Zealand, African, Jamaican, or custom accent names"],
                                "styles": ["Optional. Preset options: Clean, Gritty, Breathy, Airy, Restrained, Dynamic, Wide Vocal Range. Or use custom style descriptions"]
                            }
                        ],
                        "choir": {
                            "enabled": false,
                            "gender": "Male, Female, or Both",
                            "size": "Small (Vocal Ensemble), Medium (Chamber), Large (Chorus), or Extra Large (Massed)",
                            "ranges": ["Optional array of ranges"],
                            "accents": ["Optional array of accents"],
                            "styles": ["Optional array of vocal styles. Preset options: Clean, Gritty, Breathy, Airy, Restrained, Dynamic, Wide Vocal Range. Or use custom style descriptions"]
                        }
                    },
                    "summary": "One sentence describing what was applied"
                }

                VOCAL CONFIG INSTRUCTIONS:
                - For "Single Male" or "Single Female", provide ONE profile with matching gender
                - For "Male Duo", provide TWO profiles both with gender: "Male"
                - For "Female Duo", provide TWO profiles both with gender: "Female"
                - For "Male & Female Duo", provide TWO profiles, one Male and one Female
                - For "Instrumental", set type: "Instrumental" and omit profiles
                - Only include accents array if the accent is NOT American
                - Choir is optional - only include if the style description suggests backing vocals or choir
                - You can use preset options OR create custom values for range, accents, and styles

                If the style description does not strongly imply a different key, keep the current musical key preference.`;

                try {
                    if (!aiClient && activeApiProvider === "google") throw new Error("Google AI key not set — enter your key in the API Key bar.");
                    console.log("Prompt sent to AI:", prompt);
                    const response = await callAI(prompt);
                    const raw = response.text.replace(/```json|```/g, "").trim();
                    const s = safeParseJSON(raw);
                    console.log("AI response parsed as JSON:", s);

                    applyGenreSetting(s.genre_key || currentGenreKey || "rock", s.genre_label || "");

                    if (s.mood) applySingleTagOrCustom("mood-tags", s.mood, "mood-custom-row", "mood-custom-tag", "Custom mood");
                    if (s.rhyme) applyRhymeSetting(s.rhyme);

                    if (s.tempo) applyTempoPreference(s.tempo);

                    if (s.musical_key) {
                        document.getElementById("musical-key").value = normalizeMusicalKey(s.musical_key);
                    }

                    if (s.time_signature) {
                        const timeSignatureSelect = document.getElementById("time-signature");
                        const timeSignatureCustom = document.getElementById("time-signature-custom");
                        const presetOptions = ["Auto", "4/4", "3/4", "2/4", "6/8", "5/4", "7/4", "9/8", "12/8"];
                        if (presetOptions.includes(s.time_signature)) {
                            timeSignatureSelect.value = s.time_signature;
                        } else {
                            timeSignatureSelect.value = "Custom";
                            timeSignatureCustom.value = s.time_signature;
                        }
                        toggleTimeSignatureMode();
                    }

                    if (s.pov) applySingleTagOrCustom("pov-tags", s.pov, "pov-custom-row", "pov-custom-tag", "Custom perspective");

                    // Apply vocal configuration
                    if (s.vocal_config && s.vocal_config.type) {
                        applyVocalConfiguration(s.vocal_config);
                    }

                    if (s.instrument_exclusions) document.getElementById("instrument-exclude").value = String(s.instrument_exclusions || "");

                    if (s.era_keys && s.era_keys.length) applyMultiTagValues("era-tags", s.era_keys);
                    if (s.prodstyle_keys && s.prodstyle_keys.length) applyMultiTagValues("prodstyle-tags", s.prodstyle_keys);
                    if (s.inst_keys && s.inst_keys.length) applyMultiTagValues("inst-tags", s.inst_keys);
                    if (s.mix_keys && s.mix_keys.length) applyMultiTagValues("mix-tags", s.mix_keys);
                    if (s.influences && s.influences.length) s.influences.forEach((inf) => addInfluenceVal(inf));

                    const resultEl = document.getElementById("style-result");
                    resultEl.style.display = "block";

                    const vocalConfigDisplay = s.vocal_config && s.vocal_config.type ? `<div class="style-applied-row"><span class="style-applied-key">Vocal Config:</span><span class="style-applied-val">${s.vocal_config.type}</span></div>` : "";

                    resultEl.innerHTML = `<div class="style-result-box">
                      <span class="style-result-title">${_t("status.style_applied", "Style Applied to All Settings")}</span>
                            <div class="style-applied-row"><span class="style-applied-key">Genre:</span><span class="style-applied-val">${getSelectedGenreLabel() || s.genre_label || s.genre_key || "—"}</span></div>
                            <div class="style-applied-row"><span class="style-applied-key">Mood:</span><span class="style-applied-val">${getSelectedMood() || s.mood || "—"}</span></div>
                    <div class="style-applied-row"><span class="style-applied-key">Tempo:</span><span class="style-applied-val">${formatTempoPreference(s.tempo) || "—"}</span></div>
                    <div class="style-applied-row"><span class="style-applied-key">Key:</span><span class="style-applied-val">${normalizeMusicalKey(s.musical_key) || "—"}</span></div>
                    <div class="style-applied-row"><span class="style-applied-key">Time Sig:</span><span class="style-applied-val">${s.time_signature || "—"}</span></div>
                      <div class="style-applied-row"><span class="style-applied-key">Era:</span><span class="style-applied-val">${(s.era_keys || []).join(", ") || "—"}</span></div>
                      <div class="style-applied-row"><span class="style-applied-key">Production:</span><span class="style-applied-val">${(s.prodstyle_keys || []).join(", ") || "—"}</span></div>
                      <div class="style-applied-row"><span class="style-applied-key">Instruments:</span><span class="style-applied-val">${(s.inst_keys || []).join(", ") || "—"}</span></div>
                      <div class="style-applied-row"><span class="style-applied-key">Mix:</span><span class="style-applied-val">${(s.mix_keys || []).join(", ") || "—"}</span></div>
                            <div class="style-applied-row"><span class="style-applied-key">Perspective:</span><span class="style-applied-val">${getSelectedPov() || s.pov || "—"}</span></div>
                      ${vocalConfigDisplay}
                      ${s.influences && s.influences.length ? `<div class="style-applied-row"><span class="style-applied-key">Influences:</span><span class="style-applied-val">${s.influences.join(", ")}</span></div>` : ""}
                      <div class="style-summary">${s.summary || ""}</div>
                    </div>`;
                } catch (err) {
                    const resultEl = document.getElementById("style-result");
                    resultEl.style.display = "block";
                    resultEl.innerHTML = `<div class="error-box">Style analysis failed: ${escapeHtml(err.message)}</div>`;
                }
                btn.disabled = false;
                btn.innerHTML = _t("btn.apply_style", "Apply Style to Settings");
            }

            // ========================================================================
            // Helper Functions
            // ========================================================================
            function badgeClass(genre) {
                const g = genre.toLowerCase();
                if (g.includes("rock") || g.includes("metal") || g.includes("blues")) return "b-rock";
                if (g.includes("folk") || g.includes("country") || g.includes("americana")) return "b-folk";
                if (g.includes("jazz") || g.includes("swing") || g.includes("bebop") || g.includes("bossa")) return "b-jazz";
                if (g.includes("r&b") || g.includes("soul") || g.includes("hip")) return "b-rnb";
                if (g.includes("gospel") || g.includes("reggae") || g.includes("ska")) return "b-gospel";
                if (g.includes("latin") || g.includes("afro") || g.includes("cumbia") || g.includes("salsa")) return "b-latin";
                return "b-rock";
            }
            function sectionClass(type, isUser) {
                if (isUser) return "user-provided";
                const t = type.toLowerCase();
                if (t.includes("chorus") || t.includes("coro") || t.includes("refrain")) return "chorus";
                if (t.includes("bridge") || t.includes("mambo") || t.includes("breakdown")) return "bridge";
                if (t.includes("hook") || t.includes("intro")) return "hook";
                if (t.includes("outro") || t.includes("fade") || t.includes("coda") || t.includes("tag")) return "outro";
                if (t.includes("pre")) return "prechorus";
                return "verse";
            }
            function copyText(el, text) {
                navigator.clipboard.writeText(text).then(() => {
                    el.textContent = _t("btn.copied", "Copied!");
                    el.classList.add("copied");
                    setTimeout(() => {
                        el.textContent = _t("btn.copy", "Copy");
                        el.classList.remove("copied");
                    }, 2000);
                });
            }
            function stripLeadingSectionTag(text) {
                const lines = String(text || "").split("\n");
                while (lines.length && !lines[0].trim()) lines.shift();
                if (lines[0]) {
                    const match = lines[0].trim().match(/^\[([^\]]+)\]$/);
                    if (match && isLikelySectionTag(match[1])) {
                        lines.shift();
                    }
                }
                return lines.join("\n").trim();
            }
            function stripLeadingStyleMetaTag(text) {
                const lines = String(text || "").split("\n");
                while (lines.length && !lines[0].trim()) lines.shift();

                // If first line starts with [Style:, keep removing until we find the closing ]
                if (lines[0] && /^\[style:/i.test(lines[0].trim())) {
                    // Check if the style tag closes on the same line
                    if (lines[0].trim().endsWith("]")) {
                        lines.shift();
                    } else {
                        // Multi-line style tag - keep removing until we find the closing ]
                        lines.shift();
                        while (lines.length && !lines[0].trim().endsWith("]")) {
                            lines.shift();
                        }
                        // Remove the line with the closing ]
                        if (lines.length && lines[0].trim().endsWith("]")) {
                            lines.shift();
                        }
                    }
                    // Remove any blank lines after the style tag
                    while (lines.length && !lines[0].trim()) lines.shift();
                }

                return lines.join("\n").trim();
            }
            function stripAllLeadingMetaTags(text) {
                // Strip ALL leading bracketed tags (section tags, direction tags, etc.)
                // This prevents duplicates when direction tags are stored separately and re-added during export
                const lines = String(text || "").split("\n");

                // Remove leading empty lines
                while (lines.length && !lines[0].trim()) lines.shift();

                // Keep removing leading bracketed lines
                while (lines.length && lines[0]) {
                    const trimmed = lines[0].trim();
                    // Check if the line is a bracketed tag (handles any bracket content)
                    if (/^\[.+\]$/.test(trimmed)) {
                        lines.shift();
                        // Remove any blank lines after the tag
                        while (lines.length && !lines[0].trim()) lines.shift();
                    } else {
                        break;
                    }
                }

                return lines.join("\n").trim();
            }
            function normalizeMetaLineForCompare(value) {
                return String(value || "")
                    .trim()
                    .replace(/^\[|\]$/g, "")
                    .replace(/\s+/g, " ")
                    .replace(/[.]+$/g, "")
                    .toLowerCase();
            }
            function areSameMetaLine(a, b) {
                const aa = normalizeMetaLineForCompare(a);
                const bb = normalizeMetaLineForCompare(b);
                return !!aa && aa === bb;
            }
            function extractSectionMetaAndBody(rawText, fallbackSectionType = "") {
                const lines = String(stripLeadingStyleMetaTag(rawText || ""))
                    .replace(/\r/g, "")
                    .split("\n");

                while (lines.length && !lines[0].trim()) lines.shift();

                if (lines.length) {
                    const firstMatch = lines[0].trim().match(/^\[([^\]]+)\]$/);
                    const canonicalType = firstMatch ? extractCanonicalSectionType(firstMatch[1]) : "";
                    if (canonicalType && normalizeLooseSectionType(canonicalType) === normalizeLooseSectionType(fallbackSectionType || canonicalType)) {
                        lines.shift();
                        while (lines.length && !lines[0].trim()) lines.shift();
                    }
                }

                let direction = "";
                let instructions = "";
                while (lines.length) {
                    const trimmed = lines[0].trim();
                    const tagMatch = trimmed.match(/^\[([^\]]+)\]$/);
                    if (!tagMatch) break;
                    const content = tagMatch[1].trim();
                    if (!direction) {
                        direction = content;
                    } else if (!instructions && !areSameMetaLine(content, direction)) {
                        instructions = content;
                    }
                    lines.shift();
                    while (lines.length && !lines[0].trim()) lines.shift();
                }

                return {
                    direction,
                    instructions,
                    lines: lines.join("\n").trim(),
                };
            }
            function collectSectionMetaTags(section) {
                const tags = [];
                if (!section) return tags;

                const addTag = (value) => {
                    const cleaned = String(value || "")
                        .replace(/^\[|\]$/g, "")
                        .trim();
                    if (!cleaned) return;
                    // Skip if it duplicates the section type (AI sometimes includes [type] in instructions)
                    if (areSameMetaLine(cleaned, section.type)) return;
                    if (tags.some((existing) => areSameMetaLine(existing, cleaned))) return;
                    tags.push(cleaned);
                };

                if (Array.isArray(section.metaTags) && section.metaTags.length) {
                    section.metaTags.forEach((tag) => addTag(tag));
                    return tags;
                }

                addTag(section.direction || "");

                const instructionText = String(section.instructions || "").replace(/\r/g, "");
                const instructionChunks = instructionText
                    .split("\n")
                    .flatMap((line) => line.split(/\s*\|\s*/))
                    .map((line) => line.trim())
                    .filter(Boolean);
                instructionChunks.forEach((chunk) => addTag(chunk));

                return tags;
            }
            function normalizeStyleMetaTag(tag) {
                let cleaned = String(tag || "").trim();
                if (!cleaned) return "";
                cleaned = cleaned
                    .replace(/^\[style:\s*/i, "")
                    .replace(/\]$/, "")
                    .trim();
                return cleaned ? `[Style: ${cleaned}]` : "";
            }
            function applySunoStylePromptData(song) {
                if (!song) return;
                song.suno_style_prompt = String(song.suno_style_prompt || "").trim();
                let styleMetaTag = normalizeStyleMetaTag(song.style_meta_tag || "");

                if (song.suno_style_prompt.length > 1000) {
                    const fullPrompt = song.suno_style_prompt;
                    song.suno_style_prompt = fullPrompt.slice(0, 1000).trim();
                    const overflow = fullPrompt.slice(song.suno_style_prompt.length).trim();
                    if (overflow) {
                        styleMetaTag = normalizeStyleMetaTag(styleMetaTag ? `${styleMetaTag.replace(/^\[Style:\s*/i, "").replace(/\]$/, "")} ${overflow}` : overflow);
                    }
                }

                // Inject duration into style prompt, or [Style:] meta tag if it would exceed 1000 chars
                if (song.durationPreference) {
                    const durationLine = `Duration: ${song.durationPreference}`;
                    if (song.suno_style_prompt.length + 1 + durationLine.length <= 1000) {
                        song.suno_style_prompt = song.suno_style_prompt ? `${song.suno_style_prompt}\n${durationLine}` : durationLine;
                    } else {
                        const innerTag = styleMetaTag
                            ? styleMetaTag
                                  .replace(/^\[Style:\s*/i, "")
                                  .replace(/\]$/, "")
                                  .trim()
                            : "";
                        styleMetaTag = normalizeStyleMetaTag(innerTag ? `${durationLine}\n${innerTag}` : durationLine);
                    }
                }

                song.style_meta_tag = styleMetaTag;

                if (Array.isArray(song.sections) && song.sections.length) {
                    song.sections[0].lines = stripLeadingStyleMetaTag(song.sections[0].lines);
                    if (styleMetaTag) song.sections[0].lines = `${styleMetaTag}\n${song.sections[0].lines}`.trim();
                }
            }
            function buildAssembledLyricsPrompt(song) {
                if (!song || !Array.isArray(song.sections)) return "";

                const sp = song.soundProfile;
                const tempoPreference = formatTempoPreference(song.tempoPreference || "AI Choose");
                const vocalConfig = song.vocalProfiles ? formatVocalProfilesForPrompt(song.vocalProfiles) : song.vocalGender ? formatVocalGenderValue(song.vocalGender) : "Not specified";
                const verseLength = formatLengthPreference(song.verseLength);
                const chorusLength = formatLengthPreference(song.chorusLength);
                const styleLines = [];
                if (vocalConfig && vocalConfig !== "Not specified") styleLines.push(`Vocal: ${vocalConfig}`);
                if (song.mood) styleLines.push(`Mood: ${song.mood}`);
                if (song.goal && song.goal !== "Not specified") styleLines.push(`Goal: ${song.goal}`);
                if (song.rhythm && song.rhythm !== "AI Choose") styleLines.push(`Rhythm: ${song.rhythm}`);
                if (song.grooveFeel && song.grooveFeel !== "AI Choose") styleLines.push(`Groove Feel: ${song.grooveFeel}`);
                if (song.pov) styleLines.push(`Perspective: ${song.pov}`);
                if (tempoPreference && tempoPreference !== "AI Choose" && tempoPreference !== "Auto") styleLines.push(`Tempo Preference: ${tempoPreference}`);
                if (verseLength && verseLength !== "Follow Structure") styleLines.push(`Verse Length: ${verseLength}`);
                if (chorusLength && chorusLength !== "Follow Structure") styleLines.push(`Chorus Length: ${chorusLength}`);
                if (sp?.eras?.length) styleLines.push(`Era: ${sp.eras.join(", ")}`);
                if (sp?.styles?.length) styleLines.push(`Production style: ${sp.styles.join(", ")}`);
                if (sp?.instruments?.length) styleLines.push(`Instruments: ${sp.instruments.join(", ")}`);
                if (sp?.insts?.length) styleLines.push(`Instrumentation: ${sp.insts.join(", ")}`);
                if (sp?.bass && sp.bass !== "AI Choose") styleLines.push(`Bass: ${sp.bass}`);
                if (sp?.spatial?.length) styleLines.push(`Spatial/Effects: ${sp.spatial.join(", ")}`);
                if (sp?.mixes?.length) {
                    styleLines.push("");
                    styleLines.push(`Mix: ${sp.mixes.join(", ")}`);
                }
                if (song.production) {
                    styleLines.push("");
                    styleLines.push(`Production notes: ${song.production}`);
                }
                if (song.chords?.progression) {
                    styleLines.push("");
                    styleLines.push(`Chord progression: ${song.chords.progression}`);
                }

                const styleMetaTag = styleLines.length ? normalizeStyleMetaTag(styleLines.join("\n")) : "";
                const sections = song.sections.map((s) => {
                    const strippedLines = stripAllLeadingMetaTags(stripLeadingStyleMetaTag(s.lines || ""));
                    const metaTagLines = collectSectionMetaTags(s)
                        .map((tag) => `\n[${tag}]`)
                        .join("");
                    const raw = `[${s.type}]${metaTagLines}\n${strippedLines}`;
                    return normalizeLyricsText(raw);
                });

                const allParts = [styleMetaTag, ...sections].filter(Boolean);
                return removeDoubleBrackets(allParts.join("\n\n")).trim();
            }
            function extractLeadingStyleMetaTag(text) {
                const lines = String(text || "")
                    .replace(/\r/g, "")
                    .split("\n");
                while (lines.length && !lines[0].trim()) lines.shift();
                if (!lines.length || !/^\[style:/i.test(lines[0].trim())) {
                    return { styleMetaTag: "", body: lines.join("\n").trim() };
                }

                const metaLines = [];
                let currentLine = lines.shift();
                let remainder = currentLine.replace(/^\[style:\s*/i, "");
                if (remainder.trim().endsWith("]")) {
                    metaLines.push(remainder.replace(/\]\s*$/, ""));
                } else {
                    metaLines.push(remainder);
                    while (lines.length) {
                        currentLine = lines.shift();
                        if (currentLine.trim().endsWith("]")) {
                            metaLines.push(currentLine.replace(/\]\s*$/, ""));
                            break;
                        }
                        metaLines.push(currentLine);
                    }
                }

                while (lines.length && !lines[0].trim()) lines.shift();
                return {
                    styleMetaTag: normalizeStyleMetaTag(metaLines.join("\n").trim()),
                    body: lines.join("\n").trim(),
                };
            }
            function parseLyricsPromptSections(text, existingSections = []) {
                const lines = String(text || "")
                    .replace(/\r/g, "")
                    .split("\n");
                const sections = [];
                let currentSection = null;
                const existingSectionNames = new Set((existingSections || []).map((section) => normalizeSectionTypeForMatch(section?.type)).filter(Boolean));
                const parserEvents = [];

                const finalizeCurrent = () => {
                    if (!currentSection) return;
                    currentSection.lines = currentSection.lines.join("\n").trim();
                    if (currentSection.type || currentSection.lines) sections.push(currentSection);
                    currentSection = null;
                };

                lines.forEach((rawLine) => {
                    const line = rawLine.trim();
                    const sectionMatch = line.match(/^\[(.+?)\]$/);
                    if (sectionMatch) {
                        const sectionContent = sectionMatch[1].trim();
                        const canonicalSectionType = extractCanonicalSectionType(sectionContent);
                        const normalizedSectionType = normalizeSectionTypeForMatch(sectionContent);
                        const isKnownSection = !!canonicalSectionType || existingSectionNames.has(normalizedSectionType);

                        if (currentSection && !isKnownSection) {
                            parserEvents.push({ type: "meta", value: sectionContent, section: currentSection.type || "Lyrics" });
                            if (!currentSection.direction) currentSection.direction = sectionContent;
                            else if (!currentSection.instructions) currentSection.instructions = sectionContent;
                            else currentSection.lines.push(rawLine);
                            return;
                        }

                        if (isKnownSection) {
                            finalizeCurrent();
                            parserEvents.push({ type: "section", value: sectionContent });
                            currentSection = {
                                type: canonicalSectionType || sectionContent,
                                lines: [],
                                direction: "",
                                instructions: "",
                                userProvided: existingSections[sections.length]?.userProvided || false,
                            };
                            return;
                        }
                    }

                    if (!currentSection) {
                        currentSection = {
                            type: "Lyrics",
                            lines: [],
                            direction: "",
                            instructions: "",
                            userProvided: existingSections[sections.length]?.userProvided || false,
                        };
                    }
                    currentSection.lines.push(rawLine);
                });

                finalizeCurrent();
                debugLog("LYRICS_SHORTEN_PARSE", "Parsed AI-shortened lyrics prompt", {
                    existingSections: (existingSections || []).map((section) => section?.type || ""),
                    parsedSections: sections.map((section) => section.type),
                    parserEvents,
                });
                return sections.filter((section) => section.type || section.lines);
            }
            function validateShortenedPromptSections(parsedSections, existingSections = []) {
                const toStructureKey = (sectionType) => {
                    const raw = String(sectionType || "").trim();
                    if (!raw) return "";
                    const canonical = extractCanonicalSectionType(raw);
                    if (canonical) return normalizeSectionTypeForMatch(canonical);
                    return normalizeLooseSectionType(raw);
                };
                const expected = (existingSections || []).map((section) => toStructureKey(section?.type)).filter(Boolean);
                const actual = (parsedSections || []).map((section) => toStructureKey(section?.type)).filter(Boolean);
                if (!expected.length) return { valid: true };
                if (expected.length !== actual.length) {
                    return {
                        valid: false,
                        reason: `Section count changed from ${expected.length} to ${actual.length}.`,
                        expected,
                        actual,
                    };
                }
                for (let index = 0; index < expected.length; index++) {
                    if (expected[index] !== actual[index]) {
                        return {
                            valid: false,
                            reason: `Section ${index + 1} changed from "${existingSections[index]?.type || expected[index]}" to "${parsedSections[index]?.type || actual[index]}".`,
                            expected,
                            actual,
                        };
                    }
                }
                return { valid: true, expected, actual };
            }
            function applyStyleMetaTagToSong(song, styleMetaTag) {
                if (!song) return;

                song.style_meta_tag = normalizeStyleMetaTag(styleMetaTag || "");
                const innerText = String(song.style_meta_tag || "")
                    .replace(/^\[Style:\s*/i, "")
                    .replace(/\]$/, "")
                    .trim();
                if (!innerText) return;

                const soundProfile = song.soundProfile || {};
                innerText.split("\n").forEach((rawLine) => {
                    const line = rawLine.trim();
                    if (!line) return;
                    if (line.startsWith("Mood: ")) song.mood = line.substring(6).trim();
                    else if (line.startsWith("Goal: ")) song.goal = line.substring(6).trim();
                    else if (line.startsWith("Rhythm: ")) song.rhythm = line.substring(8).trim();
                    else if (line.startsWith("Groove Feel: ")) song.grooveFeel = line.substring(13).trim();
                    else if (line.startsWith("Perspective: ")) song.pov = line.substring(13).trim();
                    else if (line.startsWith("Tempo Preference: ")) song.tempoPreference = line.substring(18).trim();
                    else if (line.startsWith("Duration: ")) song.durationPreference = line.substring(10).trim();
                    else if (line.startsWith("Verse Length: ")) song.verseLength = line.substring(14).trim();
                    else if (line.startsWith("Chorus Length: ")) song.chorusLength = line.substring(15).trim();
                    else if (line.startsWith("Era: "))
                        soundProfile.eras = line
                            .substring(5)
                            .split(",")
                            .map((value) => value.trim())
                            .filter(Boolean);
                    else if (/^Production style: /i.test(line))
                        soundProfile.styles = line
                            .substring(line.indexOf(":") + 1)
                            .split(",")
                            .map((value) => value.trim())
                            .filter(Boolean);
                    else if (line.startsWith("Instruments: "))
                        soundProfile.instruments = line
                            .substring(13)
                            .split(",")
                            .map((value) => value.trim())
                            .filter(Boolean);
                    else if (line.startsWith("Instrumentation: "))
                        soundProfile.insts = line
                            .substring(17)
                            .split(",")
                            .map((value) => value.trim())
                            .filter(Boolean);
                    else if (line.startsWith("Bass: ")) soundProfile.bass = line.substring(6).trim();
                    else if (line.startsWith("Spatial/Effects: "))
                        soundProfile.spatial = line
                            .substring(17)
                            .split(",")
                            .map((value) => value.trim())
                            .filter(Boolean);
                    else if (line.startsWith("Mix: "))
                        soundProfile.mixes = line
                            .substring(5)
                            .split(",")
                            .map((value) => value.trim())
                            .filter(Boolean);
                    else if (line.startsWith("Production notes: ")) song.production = line.substring(18).trim();
                    else if (line.startsWith("Chord progression: ")) {
                        song.chords = song.chords || {};
                        song.chords.progression = line.substring(19).trim();
                    }
                });
                song.soundProfile = soundProfile;
            }
            async function shortenLyricsPromptWithAI(song) {
                const cleanedLyrics = removeDoubleBrackets(buildAssembledLyricsPrompt(song));
                if (!cleanedLyrics) return { updated: false, length: 0 };

                const prompt = `You are a professional songwriter and producer with deep expertise in all genres. Also you are master in Suno prompts. Here is a Suno lyric prompt which is longer than the allowed 5000 characters. Without altering the Vocal:, Mood:, Rhythm:, Groove Feel:, Tempo Preference:, Era:, Production Style:, Production style:, Instruments:, Instrumentation:, Bass:, Spatial/Effects: or Mix: lines, shorten the lyric prompt to no greater than 5000 characters by doing the following in order of preference.
1. Shorten lyrical repetition or repeated filler while preserving section labels, structure, and the core meaning.
2. Tighten section direction and instruction tags.
3. Shorten non-protected descriptive lines such as Goal, Perspective, Verse Length, Chorus Length, Production notes, and Chord progression only as much as necessary.
Do not add, remove, rename, merge, split, or reorder any lyric sections. The returned prompt must preserve the exact same section headers and section order as the supplied prompt.
Return the result in the same format as the supplied Suno Lyric Prompt.

Return ONLY valid JSON (no markdown, no backticks):
{
  "shortened_lyrics_prompt":"Full Suno lyric prompt, 5000 characters or fewer",
  "character_count": 4987
}

SUNO LYRIC PROMPT:
"""
${cleanedLyrics}
"""`;

                debugLog("LYRICS_SHORTEN_REQUEST", "Sending shorten request to AI", {
                    promptLength: prompt.length,
                    sourceLyricsLength: cleanedLyrics.length,
                    sourceSections: (song.sections || []).map((section) => section?.type || ""),
                    prompt,
                });
                console.log("=== SENDING SHORTEN REQUEST TO AI ===");
                console.log("Shorten prompt length:", prompt.length, "characters");
                console.log("Source lyrics length:", cleanedLyrics.length, "characters");
                console.log(
                    "Source sections:",
                    (song.sections || []).map((section) => section?.type || ""),
                );
                console.log("Full shorten prompt:", prompt);
                console.log("=====================================");

                const response = await callAI(prompt);
                const raw = response.text.replace(/```json|```/g, "").trim();

                debugLog("LYRICS_SHORTEN_RESPONSE", "Received shorten response from AI", {
                    responseLength: raw.length,
                    rawResponse: raw,
                });
                console.log("=== RECEIVED SHORTEN RESPONSE FROM AI ===");
                console.log("Raw shorten response length:", raw.length, "characters");
                console.log("Raw shorten response:", raw);
                console.log("========================================");

                let parsed;
                try {
                    parsed = safeParseJSON(raw);
                } catch {
                    parsed = { shortened_lyrics_prompt: raw };
                }

                debugLog("LYRICS_SHORTEN_PARSED", "Parsed shorten response", {
                    parsed,
                    reportedCharacterCount: parsed?.character_count,
                });
                console.log("=== PARSED SHORTEN RESPONSE ===");
                console.log("Parsed shorten payload:", parsed);
                console.log("================================");

                const shortenedPrompt = normalizeLyricsText(removeDoubleBrackets(String(parsed.shortened_lyrics_prompt || "").trim()));
                if (!shortenedPrompt) throw new Error("AI did not return a shortened lyrics prompt.");

                const { styleMetaTag, body } = extractLeadingStyleMetaTag(shortenedPrompt);
                const parsedSections = parseLyricsPromptSections(body, song.sections || []);
                if (!parsedSections.length) throw new Error("AI returned a shortened prompt, but no lyric sections could be parsed from it.");
                const validation = validateShortenedPromptSections(parsedSections, song.sections || []);
                debugLog("LYRICS_SHORTEN_VALIDATE", "Validated shortened section structure", validation);
                console.log("=== SHORTEN SECTION VALIDATION ===");
                console.log("Validation result:", validation);
                console.log("==================================");
                if (!validation.valid) {
                    debugLog("LYRICS_SHORTEN_SECTION_MISMATCH", "AI-shortened lyrics changed the section structure", validation);
                    throw new Error(`AI shortening changed the section structure. ${validation.reason} No new, removed, renamed, merged, or reordered sections are allowed.`);
                }

                applyStyleMetaTagToSong(song, styleMetaTag);
                song.sections = parsedSections;
                song.settings = song.settings || {};
                song.settings.userLyrics = { mode: "bulk", content: body };
                song.settings.aiMode = "keep";

                const lyricsInput = document.getElementById("lyrics-input");
                if (lyricsInput) lyricsInput.value = body;

                currentSong = song;
                renderSongCard(song);
                renderChordsCard(song);
                saveToHistory(song);

                debugLog("LYRICS_SHORTEN_APPLIED", "Applied shortened lyrics to current song", {
                    shortenedLength: shortenedPrompt.length,
                    finalSections: (song.sections || []).map((section) => section?.type || ""),
                });
                console.log("=== APPLIED SHORTENED LYRICS ===");
                console.log("Shortened prompt length:", shortenedPrompt.length, "characters");
                console.log(
                    "Final sections:",
                    (song.sections || []).map((section) => section?.type || ""),
                );
                console.log("================================");

                return { updated: true, length: shortenedPrompt.length };
            }
            function showLyricsStillTooLongWarning(len) {
                document.getElementById("validation-modal-msg").textContent = `The AI-shortened lyric prompt is still ${len.toLocaleString()} characters long, which exceeds Suno's 5,000-character limit. You will need to reduce the prompt manually.`;
                document.getElementById("validation-modal").style.display = "flex";
            }

            // ========================================================================
            // Sound Profile
            // ========================================================================
            function buildSoundProfile() {
                const eras = getActiveMulti("era-tags"),
                    styles = getActiveMulti("prodstyle-tags"),
                    instruments = getActiveMulti("instruments-tags"),
                    insts = getActiveMulti("inst-tags"),
                    mixes = getActiveMulti("mix-tags"),
                    bass = getSelectedBass(),
                    spatialRaw = getSelectedSpatialEffects(),
                    spatial = spatialRaw.filter((s) => s !== "AI Choose"),
                    infs = [...influences];
                const hasBass = bass && bass !== "AI Choose";
                if (!eras.length && !styles.length && !instruments.length && !insts.length && !mixes.length && !hasBass && !spatial.length && !infs.length) return null;
                return { eras, styles, instruments, insts, mixes, bass, spatial, infs };
            }
            function soundProfilePromptText(sp) {
                if (!sp) return "";
                const parts = [];
                if (sp.eras.length) parts.push(`Era/Decade: ${sp.eras.join(", ")}`);
                if (sp.styles.length) parts.push(`Production Style: ${sp.styles.join(", ")}`);
                if (sp.instruments && sp.instruments.length) parts.push(`Instruments: ${sp.instruments.join(", ")}`);
                if (sp.insts.length) parts.push(`Instrumentation: ${sp.insts.join(", ")}`);
                if (sp.mixes.length) parts.push(`Mix Character: ${sp.mixes.join(", ")}`);
                if (sp.bass && sp.bass !== "AI Choose") parts.push(`Bass: ${sp.bass}`);
                if (sp.spatial && sp.spatial.length) parts.push(`Spatial/Effects: ${sp.spatial.join(", ")}`);
                if (sp.infs.length) parts.push(`Key Influences: ${sp.infs.join(", ")}`);
                return parts.join("\n");
            }
            function buildSubmissionSummary({ title, concept, specialInstructions, genre, mood, goal, rhythm, grooveFeel, rhyme, tempo, duration, selectedMusicalKey, selectedTimeSignature, pov, verseLength, chorusLength, struct, soundProfile, aiMode, userLyrics, songLanguage }) {
                const tempoFormatted = formatTempoPreference(tempo);
                const vocalConfig = getSelectedVocalGender();
                const modelId = document.getElementById("model-select")?.value || selectedModel;
                const providerLabel = (modelProviderMap[modelId] || activeApiProvider) === "openrouter" ? "OpenRouter" : "Google AI";
                const parts = ["Submit these settings to AI?", "", `Provider: ${providerLabel}`, `Model: ${modelId}`, ``, `Title: ${title}`, `Concept: ${concept}`, `Genre: ${genre}`];
                if (songLanguage && songLanguage !== "English") parts.push(`Lyrics Language: ${songLanguage}`);
                if (specialInstructions) parts.push(`Special Instructions: ${specialInstructions}`);
                if (mood) parts.push(`Mood: ${mood}`);
                if (goal && goal !== "Not specified") parts.push(`Goal: ${goal}`);
                if (rhythm && rhythm !== "AI Choose") parts.push(`Rhythm: ${rhythm}`);
                if (grooveFeel && grooveFeel !== "AI Choose") parts.push(`Groove Feel: ${grooveFeel}`);
                if (rhyme) parts.push(`Rhyme: ${rhyme}`);

                if (tempoFormatted !== "AI Choose" && tempoFormatted !== "Auto") parts.push(`Tempo: ${tempoFormatted}`);
                if (duration) parts.push(`Duration: ${duration}`);
                if (selectedMusicalKey !== "Auto") parts.push(`Key: ${selectedMusicalKey}`);
                if (selectedTimeSignature !== "Auto") parts.push(`Time Signature: ${selectedTimeSignature}`);

                if (pov) parts.push(`Perspective: ${pov}`);

                if (vocalConfig !== "Not specified") parts.push(`Vocal Configuration: ${vocalConfig}`);

                const verseLengthFormatted = formatLengthPreference(verseLength);
                const chorusLengthFormatted = formatLengthPreference(chorusLength);
                if (verseLengthFormatted !== "Follow Structure" && verseLengthFormatted) parts.push(`Verse Length: ${verseLengthFormatted}`);
                if (chorusLengthFormatted !== "Follow Structure" && chorusLengthFormatted) parts.push(`Chorus Length: ${chorusLengthFormatted}`);

                parts.push(`Structure: ${struct?.name || "--"}`, `Structure Flow: ${struct?.flow || "--"}`);

                if (soundProfile) {
                    parts.push("", "Sound Profile:", soundProfilePromptText(soundProfile));
                }

                if (userLyrics) {
                    parts.push("", `Lyrics AI Mode: ${aiMode || "--"}`, `Lyrics Input: ${userLyrics.mode === "bulk" ? "All at once" : "By section"}`);
                }

                parts.push("", "Choose OK to continue or Cancel to stop.");
                return parts.join("\n");
            }
            let settingsConfirmResolver = null;
            function openSettingsConfirm(summaryText) {
                document.getElementById("settings-confirm-preview").textContent = summaryText;
                document.getElementById("settings-confirm-modal").style.display = "flex";
                return new Promise((resolve) => {
                    settingsConfirmResolver = resolve;
                });
            }
            function resolveSettingsConfirm(accepted) {
                document.getElementById("settings-confirm-modal").style.display = "none";
                const resolver = settingsConfirmResolver;
                settingsConfirmResolver = null;
                if (resolver) resolver(accepted);
            }
            function closeSettingsConfirm(event, accepted) {
                if (event.target.id === "settings-confirm-modal") resolveSettingsConfirm(accepted);
            }

            function openResetConfirm() {
                document.getElementById("reset-confirm-modal").style.display = "flex";
            }
            function closeResetConfirm() {
                document.getElementById("reset-confirm-modal").style.display = "none";
            }
            function confirmReset() {
                // Explicitly clear all text fields so browser form-memory / autocomplete
                // does not repopulate them after the page reload.
                document.querySelectorAll("input[type=text], input:not([type]), textarea").forEach((el) => {
                    el.value = "";
                });
                // Clear session-local app state from localStorage (keep API keys and history).
                localStorage.removeItem("selected_model");
                localStorage.removeItem("active_api_provider");
                location.reload();
            }
            function closeValidationModal() {
                document.getElementById("validation-modal").style.display = "none";
            }

            let submitConfirmResolver = null;
            let keepModeWarningResolver = null;
            let _lyricsTooLongResolver = null;
            function calcAssembledLyricsLength(song) {
                return buildAssembledLyricsPrompt(song).length;
            }
            function openLyricsTooLongModal(len) {
                const excess = len - 5000;
                const newMax = Math.max(1000, 4500 - excess);
                const detail = document.getElementById("lyrics-too-long-detail");
                if (detail) {
                    detail.textContent = `The assembled lyrics are ${len.toLocaleString()} characters — ${excess.toLocaleString()} over Suno's 5,000-character limit.\n\nIf the AI shortens them, the new character limit will be set to ${newMax.toLocaleString()}.\n\nChoose how to proceed:`;
                }
                document.getElementById("lyrics-too-long-modal").style.display = "flex";
                return new Promise((resolve) => {
                    _lyricsTooLongResolver = resolve;
                });
            }
            function resolveLyricsTooLong(choice) {
                document.getElementById("lyrics-too-long-modal").style.display = "none";
                if (_lyricsTooLongResolver) {
                    const fn = _lyricsTooLongResolver;
                    _lyricsTooLongResolver = null;
                    fn(choice);
                }
            }
            function openSubmitConfirm(summaryText) {
                document.getElementById("submit-confirm-preview").textContent = summaryText;
                document.getElementById("submit-confirm-modal").style.display = "flex";
                return new Promise((resolve) => {
                    submitConfirmResolver = resolve;
                });
            }
            function openKeepModeWarningModal() {
                document.getElementById("keepmode-warning-modal").style.display = "flex";
                return new Promise((resolve) => {
                    keepModeWarningResolver = resolve;
                });
            }
            function resolveKeepModeWarning(accepted) {
                document.getElementById("keepmode-warning-modal").style.display = "none";
                const resolver = keepModeWarningResolver;
                keepModeWarningResolver = null;
                if (resolver) resolver(accepted);
            }
            function closeKeepModeWarningModal(event, accepted) {
                if (event.target.id === "keepmode-warning-modal") resolveKeepModeWarning(accepted);
            }
            function resolveSubmitConfirm(accepted) {
                document.getElementById("submit-confirm-modal").style.display = "none";
                const resolver = submitConfirmResolver;
                submitConfirmResolver = null;
                if (resolver) resolver(accepted);
            }
            function closeSubmitConfirm(event, accepted) {
                if (event.target.id === "submit-confirm-modal") resolveSubmitConfirm(accepted);
            }

            // ========================================================================
            // User Lyrics
            // Handles user-provided lyrics and section parsing
            // ========================================================================
            function getUserLyrics() {
                if (activeLeftTab !== "lyrics") return null;
                const lyricsInput = document.getElementById("lyrics-input").value.trim();
                return lyricsInput ? { mode: "bulk", content: lyricsInput } : null;
            }
            function normalizeSectionTypeForMatch(value) {
                return String(value || "")
                    .trim()
                    .toLowerCase()
                    .replace(/^[\[]|[\]]$/g, "")
                    .replace(/\s+/g, " ");
            }
            function normalizeLooseSectionType(value) {
                return normalizeSectionTypeForMatch(value).replace(/\s+(\d+|[ivxlcdm]+)$/i, "");
            }
            function toDisplaySectionBase(base) {
                const normalized = String(base || "")
                    .toLowerCase()
                    .replace(/\s+/g, " ")
                    .trim();
                const map = {
                    intro: "Intro",
                    outro: "Outro",
                    verse: "Verse",
                    "pre-chorus": "Pre-Chorus",
                    "post-chorus": "Post-Chorus",
                    chorus: "Chorus",
                    hook: "Hook",
                    refrain: "Refrain",
                    bridge: "Bridge",
                    interlude: "Interlude",
                    instrumental: "Instrumental",
                    solo: "Solo",
                    "guitar solo": "Guitar Solo",
                    breakdown: "Breakdown",
                    drop: "Drop",
                    build: "Build",
                    coda: "Coda",
                    tag: "Tag",
                    turnaround: "Turnaround",
                };
                return map[normalized] || normalized;
            }
            function extractCanonicalSectionType(label) {
                const raw = String(label || "")
                    .trim()
                    .replace(/^[\[]|[\]]$/g, "")
                    .replace(/\s+/g, " ");
                if (!raw) return "";

                const headerMatch = raw.match(/^(intro|outro|verse|pre-chorus|post-chorus|chorus|hook|refrain|bridge|interlude|instrumental|guitar solo|solo|breakdown|drop|build|coda|tag|turnaround)(?:\s+(\d+|[ivxlcdm]+))?(?:\s*(?:[:.-].*)|\s+\d+\s*bars?\b.*)?$/i);
                if (!headerMatch) return "";

                const base = toDisplaySectionBase(headerMatch[1]);
                const suffix = (headerMatch[2] || "").trim();
                return suffix ? `${base} ${suffix}` : base;
            }
            function isLikelySectionTag(label) {
                return !!extractCanonicalSectionType(label);
            }
            // Parse bulk lyrics text into structured sections
            // Handles section tags like [Verse], [Chorus], chord progressions, and instructions
            function parsePreservedBulkLyricsSections(text) {
                const lines = String(text || "")
                    .replace(/\r/g, "")
                    .split("\n");
                const sections = [];
                let current = null;
                let sawSectionTag = false;
                let preambleLines = []; // Store lines before first section tag

                const pushCurrent = () => {
                    if (!current) return;
                    const joined = current.lines.join("\n").replace(/^\n+|\n+$/g, "");
                    if (!joined.trim() && !current.type) {
                        current = null;
                        return;
                    }
                    sections.push({
                        type: current.type || "Lyrics",
                        lines: joined,
                        direction: "",
                        userProvided: true,
                    });
                    current = null;
                };

                lines.forEach((line) => {
                    const trimmed = line.trim();
                    const match = trimmed.match(/^\[([^\]]+)\]$/);
                    const canonicalSectionType = match ? extractCanonicalSectionType(match[1]) : "";
                    if (canonicalSectionType) {
                        sawSectionTag = true;
                        pushCurrent();
                        current = { type: canonicalSectionType, lines: [] };
                        // If this is the first section tag and we have preamble, add it to this section
                        if (preambleLines.length > 0) {
                            current.lines.push(...preambleLines);
                            preambleLines = [];
                        }
                        return;
                    }
                    // If we haven't seen a section tag yet, store in preamble
                    if (!sawSectionTag) {
                        preambleLines.push(line);
                        return;
                    }
                    if (!current) current = { type: "", lines: [] };
                    current.lines.push(line);
                });
                pushCurrent();

                if (!sawSectionTag) {
                    return [
                        {
                            type: "Lyrics",
                            lines: String(text || "").trim(),
                            direction: "",
                            userProvided: true,
                        },
                    ];
                }

                return sections.filter((section) => section.lines.trim());
            }
            function parseKeepModeSectionsFromBulkLyrics(text) {
                const lines = String(text || "")
                    .replace(/\r/g, "")
                    .split("\n");

                const sections = [];
                let current = null;

                const pushCurrent = () => {
                    if (!current || !current.type) {
                        current = null;
                        return;
                    }
                    const directionTags = current.directionTags.filter(Boolean);
                    sections.push({
                        type: current.type,
                        direction: directionTags[0] || "",
                        instructions: directionTags.slice(1).join("\n"),
                        metaTags: directionTags,
                        lines: current.lyricLines.join("\n").trim(),
                        userProvided: true,
                    });
                    current = null;
                };

                lines.forEach((rawLine) => {
                    const trimmed = rawLine.trim();
                    const bracketMatch = trimmed.match(/^\[([^\]]+)\]$/);
                    const canonicalSectionType = bracketMatch ? extractCanonicalSectionType(bracketMatch[1]) : "";

                    if (canonicalSectionType) {
                        pushCurrent();
                        const verboseText = bracketMatch[1].trim();
                        const verboseSuffix = verboseText.slice(canonicalSectionType.length).trim();
                        current = { type: canonicalSectionType, directionTags: verboseSuffix ? [verboseSuffix] : [], lyricLines: [] };
                        return;
                    }

                    if (!current) return;

                    if (bracketMatch) {
                        current.directionTags.push(bracketMatch[1].trim());
                        return;
                    }

                    current.lyricLines.push(rawLine);
                });

                pushCurrent();
                return sections;
            }
            function hasClearKeepModeSectionIdentifiers(text) {
                return parseKeepModeSectionsFromBulkLyrics(text).length > 0;
            }
            function buildPreservedUserSections(userLyrics) {
                if (!userLyrics) return [];
                if (userLyrics.mode === "bulk") return parsePreservedBulkLyricsSections(userLyrics.content);
                const orderedEntries = SECTION_LABELS.map((label) => [label, userLyrics.content?.[label]]).filter(([, value]) => value && String(value).trim());
                const extraEntries = Object.entries(userLyrics.content || {}).filter(([label, value]) => value && String(value).trim() && !SECTION_LABELS.includes(label));
                return [...orderedEntries, ...extraEntries].map(([type, lines]) => ({
                    type,
                    lines: String(lines || "").trim(),
                    direction: "",
                    userProvided: true,
                }));
            }
            function findGeneratedSectionIndex(sections, targetType, startIndex = 0) {
                const exactTarget = normalizeSectionTypeForMatch(targetType);
                const looseTarget = normalizeLooseSectionType(targetType);
                for (let i = startIndex; i < sections.length; i++) {
                    if (normalizeSectionTypeForMatch(sections[i]?.type) === exactTarget) return i;
                }
                for (let i = startIndex; i < sections.length; i++) {
                    if (normalizeLooseSectionType(sections[i]?.type) === looseTarget) return i;
                }
                return -1;
            }
            function mergePreservedLyricsSections(generatedSections, userLyrics, aiMode) {
                if (aiMode !== "keep" || !userLyrics) return Array.isArray(generatedSections) ? generatedSections : [];
                const merged = Array.isArray(generatedSections) ? generatedSections.map((section) => ({ ...section })) : [];
                const preservedSections = buildPreservedUserSections(userLyrics);
                if (!preservedSections.length) return merged;

                let searchStart = 0;
                preservedSections.forEach((preservedSection) => {
                    const preservedMeta = extractSectionMetaAndBody(preservedSection.lines, preservedSection.type);
                    const matchIndex = findGeneratedSectionIndex(merged, preservedSection.type, searchStart);
                    if (matchIndex >= 0) {
                        merged[matchIndex] = {
                            ...merged[matchIndex],
                            type: preservedSection.type || merged[matchIndex].type,
                            direction: preservedMeta.direction || merged[matchIndex].direction || "",
                            instructions: preservedMeta.instructions || merged[matchIndex].instructions || "",
                            lines: preservedMeta.lines,
                            userProvided: true,
                        };
                        searchStart = matchIndex + 1;
                        return;
                    }

                    const insertIndex = Math.min(searchStart, merged.length);
                    merged.splice(insertIndex, 0, {
                        ...preservedSection,
                        direction: preservedMeta.direction,
                        instructions: preservedMeta.instructions,
                        lines: preservedMeta.lines,
                    });
                    searchStart = insertIndex + 1;
                });

                if (!merged.some((section) => section?.userProvided)) {
                    return preservedSections.map((preservedSection) => {
                        const preservedMeta = extractSectionMetaAndBody(preservedSection.lines, preservedSection.type);
                        return {
                            type: preservedSection.type,
                            direction: preservedMeta.direction,
                            instructions: preservedMeta.instructions,
                            lines: preservedMeta.lines,
                            userProvided: true,
                        };
                    });
                }

                return merged;
            }
            function mergeRedirSections(aiSections, parsedUserSections) {
                if (!parsedUserSections.length) return Array.isArray(aiSections) ? aiSections : [];
                const merged = Array.isArray(aiSections) ? aiSections.map((s) => ({ ...s })) : [];
                let searchStart = 0;
                parsedUserSections.forEach((userSection) => {
                    const matchIndex = findGeneratedSectionIndex(merged, userSection.type, searchStart);
                    if (matchIndex >= 0) {
                        merged[matchIndex] = {
                            ...merged[matchIndex],
                            lines: userSection.lines,
                            userProvided: true,
                        };
                        searchStart = matchIndex + 1;
                    } else {
                        const insertIndex = Math.min(searchStart, merged.length);
                        merged.splice(insertIndex, 0, {
                            type: userSection.type,
                            direction: "",
                            instructions: "",
                            lines: userSection.lines,
                            userProvided: true,
                        });
                        searchStart = insertIndex + 1;
                    }
                });
                return merged;
            }
            function setSectionLyricsInputs(sectionContent = {}) {
                const sectionRows = document.getElementById("section-rows");
                if (!sectionRows) return;
                buildSectionRows();
                document.querySelectorAll("#section-rows textarea").forEach((ta) => {
                    ta.value = sectionContent[ta.dataset.section] || "";
                });
            }
            // Restore saved structure from history or import
            // Handles both preset structures and custom sequences with chords/instructions
            function applySavedStructure(structureData, genreKey = currentGenreKey) {
                const name = structureData?.name?.trim();
                const flow = structureData?.flow?.trim();
                const desc = structureData?.desc?.trim();
                const tag = structureData?.tag?.trim() || "Saved";
                const sequence = structureData?.sequence; // Extract sequence if present

                if (!name && !flow) {
                    clearCustomStructure(genreKey);
                    buildStructureList(genreKey);
                    activateStructureIndex(genreKey, 0);
                    return;
                }

                const presetIndex = findMatchingStructureIndex(genreKey, name, flow);
                if (presetIndex >= 0) {
                    clearCustomStructure(genreKey);
                    buildStructureList(genreKey);
                    activateStructureIndex(genreKey, presetIndex);
                    return;
                }

                // If sequence exists, populate customStructureDraft
                // Sequence contains section names with optional chord progressions and instructions
                if (sequence && Array.isArray(sequence) && sequence.length > 0) {
                    customStructureDraft = sequence.map((step) => ({
                        name: step.name || "Section",
                        chords: step.chords || "",
                        instructions: step.instructions || "",
                    }));
                } else {
                    customStructureDraft = [];
                }

                const structDataForSync = {
                    genreKey,
                    source: "history",
                    name: name || "Saved Structure",
                    tag,
                    flow: flow || (customStructureDraft.length > 0 ? structureFlowFromSequence(customStructureDraft) : "Custom flow"),
                    desc: desc || "Restored from saved song history.",
                    sequence: customStructureDraft.length > 0 ? [...customStructureDraft] : undefined,
                };

                // Sync fields and apply the custom structure
                syncCustomStructureBuilderFields(structDataForSync);
                applyCustomStructureBuilder("history");
            }
            // Capture complete snapshot of all current settings for history storage
            function captureCurrentSettingsSnapshot() {
                // Capture lyrics from input field if available, or reconstruct from current song sections
                let lyricsInput = document.getElementById("lyrics-input").value.trim();

                // If lyrics input is empty but we have a current song with sections, capture those lyrics
                if (!lyricsInput && currentSong && Array.isArray(currentSong.sections) && currentSong.sections.length > 0) {
                    lyricsInput = currentSong.sections
                        .map((s) => {
                            const sectionHeader = `[${s.type}]`;
                            const metaTagLines = collectSectionMetaTags(s)
                                .map((tag) => `[${tag}]`)
                                .join("\n");
                            const sectionLines = stripAllLeadingMetaTags(s.lines || "").trim();
                            const sectionPrefix = metaTagLines ? `${sectionHeader}\n${metaTagLines}` : sectionHeader;
                            return sectionLines ? `${sectionPrefix}\n${sectionLines}` : sectionPrefix;
                        })
                        .filter(Boolean)
                        .join("\n\n");
                }

                const userLyricsForHistory = lyricsInput ? { mode: "bulk", content: lyricsInput } : null;

                return {
                    title: document.getElementById("title").value.trim(),
                    concept: document.getElementById("concept").value.trim(),
                    specialInstructions: document.getElementById("special-instructions").value.trim(),
                    genreKey: currentGenreKey,
                    genreLabel: getSelectedGenreLabel(),
                    mood: getActive("mood-tags") || getCustomTagValue("mood-custom-tag"),
                    goal: getActive("goal-tags") || getCustomTagValue("goal-custom-tag"),
                    rhythm: getActive("rhythm-tags") || getCustomTagValue("rhythm-custom-tag"),
                    grooveFeel: getActive("groove-tags") || getCustomTagValue("groove-custom-tag"),
                    rhyme: getActive("rhyme-tags"),
                    tempo: formatTempoPreference(getTempoPreference()),
                    musicalKey: getSelectedMusicalKey(),
                    timeSignature: getSelectedTimeSignature(),
                    pov: getActive("pov-tags") || getCustomTagValue("pov-custom-tag"),
                    vocalProfiles: getVocalProfiles(),
                    verseLength: document.getElementById("verse-length-select").value,
                    chorusLength: document.getElementById("chorus-length-select").value,
                    structure: selectedStructure
                        ? {
                              name: selectedStructure.name,
                              flow: selectedStructure.flow,
                              desc: selectedStructure.desc,
                              tag: selectedStructure.tag,
                              sequence: selectedStructure.sequence,
                          }
                        : null,
                    soundProfile: buildSoundProfile(),
                    lyricsMode: "single",
                    aiMode: getActive("aimode-tags"),
                    userLyrics: userLyricsForHistory,
                    instrumentExclusions: getInstrumentExclusions(),
                    songLanguage: getSongLanguage(),
                    durationMode: document.getElementById("duration-mode")?.value || "none",
                    durationMin: parseInt(document.getElementById("duration-min")?.value || "180"),
                    durationMax: parseInt(document.getElementById("duration-max")?.value || "180"),
                };
            }
            // Restore vocal profiles from saved settings
            // Rebuilds vocal configuration UI with saved gender, range, accents, and styles
            function restoreVocalProfiles(vocalProfilesData) {
                if (!vocalProfilesData || !vocalProfilesData.type) {
                    // Default to Single Male
                    buildVocalProfiles();
                    return;
                }

                // Set vocal type - use selectVocalType to correctly handle visibility,
                // choir builder construction, and Choir/Ensemble mode
                const typeTag = document.querySelector(`#vocal-type-tags .tag[data-val="${vocalProfilesData.type}"]`);
                if (typeTag) {
                    selectVocalType(typeTag);
                } else {
                    buildVocalProfiles();
                }

                // Restore each profile's settings
                if (vocalProfilesData.profiles && vocalProfilesData.profiles.length) {
                    const container = document.getElementById("vocal-profiles-container");
                    vocalProfilesData.profiles.forEach((profile, idx) => {
                        if (profile.gender) {
                            const genderSelect = container.querySelector(`.vp-gender[data-idx="${idx}"]`);
                            if (genderSelect) genderSelect.value = profile.gender;
                        }
                        if (profile.range) {
                            const rangeSelect = container.querySelector(`.vp-range[data-idx="${idx}"]`);
                            if (rangeSelect) {
                                // Check if this range value exists in the options
                                if (!rangeSelect.querySelector(`option[value="${escapeAttr(profile.range)}"]`)) {
                                    // It's a custom range - add it as an option
                                    const customOption = document.createElement("option");
                                    customOption.value = profile.range;
                                    customOption.textContent = profile.range;
                                    // Insert before the "+ Custom Range..." option
                                    const customMarker = rangeSelect.querySelector('option[value="__custom__"]');
                                    rangeSelect.insertBefore(customOption, customMarker);
                                }
                                rangeSelect.value = profile.range;
                            }
                        }
                        // Restore accents (now as chips)
                        if (profile.accents && profile.accents.length) {
                            const accentContainer = container.querySelector(`#vp-accent-${idx}`);
                            if (accentContainer) {
                                profile.accents.forEach((accent) => {
                                    const accentTag = accentContainer.querySelector(`.tag[data-val="${accent}"]`);
                                    if (accentTag) {
                                        accentTag.classList.add("active");
                                    } else {
                                        // Custom accent - add as custom tag
                                        addCustomTagToRow(`vp-accent-${idx}`, accent);
                                    }
                                });
                            }
                        }
                        // Legacy: handle old single accent field
                        if (profile.accent && !profile.accents) {
                            const accentContainer = container.querySelector(`#vp-accent-${idx}`);
                            if (accentContainer) {
                                const accentTag = accentContainer.querySelector(`.tag[data-val="${profile.accent}"]`);
                                if (accentTag) accentTag.classList.add("active");
                            }
                        }
                        if (profile.styles && profile.styles.length) {
                            const styleContainer = container.querySelector(`#vp-style-${idx}`);
                            if (styleContainer) {
                                profile.styles.forEach((style) => {
                                    const styleTag = styleContainer.querySelector(`.tag[data-val="${style}"]`);
                                    if (styleTag) {
                                        styleTag.classList.add("active");
                                    } else {
                                        // Custom style — add as custom tag
                                        addCustomTagToRow(`vp-style-${idx}`, style);
                                    }
                                });
                            }
                        }
                    });
                }

                // Restore choir if present
                if (vocalProfilesData.choir) {
                    const isChoirEnsemble = vocalProfilesData.type === "Choir/Ensemble";
                    if (!isChoirEnsemble) {
                        // For other types, enable the backing choir checkbox
                        document.getElementById("choir-enabled").checked = true;
                        toggleChoir(true);
                    }
                    // For Choir/Ensemble the builder was already shown by selectVocalType above

                    // Wait for choir builder to be created then restore values
                    setTimeout(() => {
                        if (vocalProfilesData.choir.gender) {
                            const genderSelect = document.getElementById("choir-gender");
                            if (genderSelect) genderSelect.value = vocalProfilesData.choir.gender;
                        }
                        if (vocalProfilesData.choir.size) {
                            const sizeSelect = document.getElementById("choir-size");
                            if (sizeSelect) sizeSelect.value = vocalProfilesData.choir.size;
                        }
                        if (vocalProfilesData.choir.ranges && vocalProfilesData.choir.ranges.length) {
                            const rangeContainer = document.getElementById("choir-range-tags");
                            if (rangeContainer) {
                                vocalProfilesData.choir.ranges.forEach((range) => {
                                    const rangeTag = rangeContainer.querySelector(`.tag[data-val="${range}"]`);
                                    if (rangeTag) rangeTag.classList.add("active");
                                });
                            }
                        }
                        if (vocalProfilesData.choir.accents && vocalProfilesData.choir.accents.length) {
                            const accentContainer = document.getElementById("choir-accent-tags");
                            if (accentContainer) {
                                vocalProfilesData.choir.accents.forEach((accent) => {
                                    const accentTag = accentContainer.querySelector(`.tag[data-val="${accent}"]`);
                                    if (accentTag) {
                                        accentTag.classList.add("active");
                                    } else {
                                        // Custom accent
                                        addCustomTagToRow("choir-accent-tags", accent);
                                    }
                                });
                            }
                        }
                        if (vocalProfilesData.choir.styles && vocalProfilesData.choir.styles.length) {
                            const styleContainer = document.getElementById("choir-style-tags");
                            if (styleContainer) {
                                vocalProfilesData.choir.styles.forEach((style) => {
                                    const styleTag = styleContainer.querySelector(`.tag[data-val="${style}"]`);
                                    if (styleTag) {
                                        styleTag.classList.add("active");
                                    } else {
                                        addCustomTagToRow("choir-style-tags", style);
                                    }
                                });
                            }
                        }
                    }, 50);
                }
            }
            function applyHistorySettings(song) {
                const settings = song?.settings || {};

                document.getElementById("title").value = settings.title ?? song.title ?? "";
                document.getElementById("concept").value = settings.concept || song.concept || "";
                document.getElementById("special-instructions").value = settings.specialInstructions ?? song.specialInstructions ?? "";

                applyGenreSetting(settings.genreKey || currentGenreKey || "rock", settings.genreLabel || song.genre || "");
                applySingleTagOrCustom("mood-tags", settings.mood || song.mood || "", "mood-custom-row", "mood-custom-tag", "Custom mood");
                applySingleTagOrCustom("goal-tags", settings.goal || song.goal || "", "goal-custom-row", "goal-custom-tag", "Custom goal");
                applySingleTagOrCustom("rhythm-tags", settings.rhythm || song.rhythm || "", "rhythm-custom-row", "rhythm-custom-tag", "Custom rhythm");
                applySingleTagOrCustom("groove-tags", settings.grooveFeel || song.grooveFeel || "", "groove-custom-row", "groove-custom-tag", "Custom groove feel");
                applyRhymeSetting(settings.rhyme || song.rhyme || "AABB (couplets)");

                applyTempoPreference(settings.tempo || song.tempoPreference || song.key_info?.tempo || "AI Choose");

                // Restore duration preference
                const durationModeEl = document.getElementById("duration-mode");
                if (durationModeEl) {
                    durationModeEl.value = settings.durationMode || "none";
                    if ((settings.durationMode || "none") === "custom") {
                        const dMin = document.getElementById("duration-min");
                        const dMax = document.getElementById("duration-max");
                        if (dMin) dMin.value = settings.durationMin ?? 180;
                        if (dMax) dMax.value = settings.durationMax ?? 180;
                    }
                    toggleDurationMode();
                    updateDurationRange();
                }

                document.getElementById("musical-key").value = normalizeMusicalKey(settings.musicalKey || song.key_info?.key || "Auto");

                // Restore time signature
                const timeSignatureValue = settings.timeSignature || song.key_info?.time_sig || "4/4";
                const timeSignatureSelect = document.getElementById("time-signature");
                const timeSignatureCustom = document.getElementById("time-signature-custom");
                const presetOptions = ["Auto", "4/4", "3/4", "2/4", "6/8", "5/4", "7/4", "9/8", "12/8"];
                if (presetOptions.includes(timeSignatureValue)) {
                    timeSignatureSelect.value = timeSignatureValue;
                } else {
                    timeSignatureSelect.value = "Custom";
                    timeSignatureCustom.value = timeSignatureValue;
                }
                toggleTimeSignatureMode();

                applySingleTagOrCustom("pov-tags", settings.pov || "first person (I/me)", "pov-custom-row", "pov-custom-tag", "Custom perspective");

                // Restore vocal profiles
                restoreVocalProfiles(settings.vocalProfiles || null);

                document.getElementById("verse-length-select").value = settings.verseLength || song.verseLength || "";
                document.getElementById("chorus-length-select").value = settings.chorusLength || song.chorusLength || "";

                influences = [];
                renderInfluenceChips();

                applyMultiTagValues("era-tags", settings.soundProfile?.eras || song.soundProfile?.eras || []);
                applyMultiTagValues("prodstyle-tags", settings.soundProfile?.styles || song.soundProfile?.styles || []);
                applyMultiTagValues("instruments-tags", settings.soundProfile?.instruments || song.soundProfile?.instruments || []);
                applyMultiTagValues("inst-tags", settings.soundProfile?.insts || song.soundProfile?.insts || []);
                applyMultiTagValues("mix-tags", settings.soundProfile?.mixes || song.soundProfile?.mixes || []);
                applySingleTagOrCustom("bass-tags", settings.soundProfile?.bass || song.soundProfile?.bass || "", "bass-custom-row", "bass-custom-tag", "Custom bass");
                applyMultiTagValues("spatial-tags", settings.soundProfile?.spatial || song.soundProfile?.spatial || []);
                (settings.soundProfile?.infs || song.soundProfile?.infs || []).forEach((inf) => addInfluenceVal(inf));

                if (settings.structure) applySavedStructure(settings.structure, currentGenreKey);
                else if (song.structureName) applySavedStructure({ name: song.structureName }, currentGenreKey);
                else {
                    clearCustomStructure(currentGenreKey);
                    buildStructureList(currentGenreKey);
                }

                const savedAiMode = settings.aiMode || "complete";
                let aiModeMatched = false;
                document
                    .getElementById("aimode-tags")
                    .querySelectorAll(".tag")
                    .forEach((t) => {
                        const isMatch = t.dataset.val === savedAiMode;
                        t.classList.toggle("active", isMatch);
                        if (isMatch) aiModeMatched = true;
                    });
                if (!aiModeMatched) {
                    const defaultAiMode = document.getElementById("aimode-tags").querySelector('.tag[data-val="complete"]');
                    if (defaultAiMode) defaultAiMode.classList.add("active");
                }

                // Restore lyrics to lyrics input
                const lyricsInputElement = document.getElementById("lyrics-input");
                if (lyricsInputElement) {
                    if (settings.userLyrics?.content) {
                        lyricsInputElement.value = settings.userLyrics.content;
                    } else {
                        lyricsInputElement.value = "";
                    }
                }
                // restore instrument exclusions
                document.getElementById("instrument-exclude").value = settings.instrumentExclusions || song.instrumentExclusions || "";
                applySongLanguageSetting(settings.songLanguage || song.songLanguage || "English");
            }

            // ========================================================================
            // Song Presets
            // Saves and restores named setting snapshots (title / concept / lyrics excluded)
            // ========================================================================

            function loadPresetsFromStorage() {
                try {
                    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
                    songPresets = raw ? safeParseJSON(raw) || [] : [];
                    if (!Array.isArray(songPresets)) songPresets = [];
                } catch (_) {
                    songPresets = [];
                }
                renderPresets();
            }

            function persistPresets() {
                try {
                    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(songPresets));
                } catch (err) {
                    console.warn("Could not save presets:", err);
                }
                scheduleDriveSync();
            }

            function mergePresetsCollections(base, incoming) {
                const combined = [...(Array.isArray(base) ? base : []), ...(Array.isArray(incoming) ? incoming : [])];
                const seen = new Set();
                const merged = [];
                for (const p of combined) {
                    if (!p?.id || seen.has(p.id)) continue;
                    seen.add(p.id);
                    merged.push(p);
                }
                return merged.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
            }

            function renderPresets() {
                const sel = document.getElementById("preset-select");
                if (!sel) return;
                const prev = sel.value;
                sel.innerHTML = `<option value="">${_t("ph.preset_select", "\u2014 select preset \u2014")}</option>`;
                for (const p of songPresets) {
                    const opt = document.createElement("option");
                    opt.value = p.id;
                    opt.textContent = p.name;
                    sel.appendChild(opt);
                }
                if (prev && songPresets.find((p) => p.id === prev)) sel.value = prev;
                onPresetSelectChange();
            }

            function onPresetSelectChange() {
                const sel = document.getElementById("preset-select");
                const loadBtn = document.getElementById("preset-load-btn");
                const delBtn = document.getElementById("preset-delete-btn");
                const hasSelection = !!sel?.value;
                if (loadBtn) loadBtn.disabled = !hasSelection;
                if (delBtn) delBtn.disabled = !hasSelection;
            }

            function savePreset() {
                const nameInput = document.getElementById("preset-name-input");
                const name = (nameInput?.value || "").trim();
                if (!name) {
                    alert(_t("alert.preset_name_required", "Please enter a preset name."));
                    nameInput?.focus();
                    return;
                }
                const snap = captureCurrentSettingsSnapshot();
                delete snap.title;
                delete snap.concept;
                delete snap.userLyrics;
                const preset = { id: String(Date.now()), name, createdAt: new Date().toISOString(), settings: snap };
                songPresets.push(preset);
                persistPresets();
                renderPresets();
                const sel = document.getElementById("preset-select");
                if (sel) {
                    sel.value = preset.id;
                    onPresetSelectChange();
                }
                if (nameInput) nameInput.value = "";
            }

            function loadPreset() {
                const sel = document.getElementById("preset-select");
                const id = sel?.value;
                if (!id) return;
                const preset = songPresets.find((p) => p.id === id);
                if (!preset) return;
                const titleEl = document.getElementById("title");
                const conceptEl = document.getElementById("concept");
                const lyricsEl = document.getElementById("lyrics-input");
                const savedTitle = titleEl?.value || "";
                const savedConcept = conceptEl?.value || "";
                const savedLyrics = lyricsEl?.value || "";
                applyHistorySettings({ settings: { ...preset.settings, title: "", concept: "", userLyrics: null } });
                if (titleEl) titleEl.value = savedTitle;
                if (conceptEl) conceptEl.value = savedConcept;
                if (lyricsEl) lyricsEl.value = savedLyrics;
            }

            function deletePreset() {
                const sel = document.getElementById("preset-select");
                const id = sel?.value;
                if (!id) return;
                const preset = songPresets.find((p) => p.id === id);
                if (!preset) return;
                if (!confirm(_fmt("alert.preset_delete_confirm", 'Delete preset "{0}"?', preset.name))) return;
                songPresets = songPresets.filter((p) => p.id !== id);
                persistPresets();
                renderPresets();
            }

            // ========================================================================
            // History Management
            // Saves and restores song configurations to/from local cache and optional Drive sync
            // ========================================================================
            function persistHistory() {
                try {
                    localStorage.setItem(SONG_HISTORY_STORAGE_KEY, JSON.stringify(history));
                } catch (err) {
                    console.warn("Could not save song history:", err);
                }
                scheduleDriveSync();
            }

            function loadHistoryFromStorage() {
                try {
                    const raw = localStorage.getItem(SONG_HISTORY_STORAGE_KEY);
                    if (!raw) {
                        history = [];
                        return;
                    }
                    const parsed = safeParseJSON(raw);
                    history = Array.isArray(parsed) ? parsed : [];
                } catch (err) {
                    console.warn("Could not load song history:", err);
                    history = [];
                }
            }

            function saveToHistory(song) {
                const snapshot = captureCurrentSettingsSnapshot();
                console.log("saveToHistory - captured snapshot:", snapshot);
                console.log("saveToHistory - userLyrics in snapshot:", snapshot.userLyrics);

                // Ensure top-level song.concept is always populated (used as fallback in applyHistorySettings)
                if (!song.concept && snapshot.concept) {
                    song.concept = snapshot.concept;
                }

                history.unshift({ ...song, settings: snapshot, savedAt: new Date().toISOString(), id: Date.now() });
                persistHistory();
                renderHistory();
            }
            function renderHistory() {
                const list = document.getElementById("history-list");
                document.getElementById("hist-count").textContent = history.length ? `(${history.length})` : "";
                if (!history.length) {
                    list.innerHTML = `<div class="output-empty" style="padding:30px 0;"><div class="empty-label">${_t("empty.history_label", "No songs saved yet")}</div></div>`;
                    return;
                }
                list.innerHTML = history
                    .map((s) => {
                        const d = new Date(s.savedAt);
                        const ts = d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
                        return `<div class="hist-item"><div><div class="hist-title">${escapeHtml(s.title)}</div><div class="hist-meta">${escapeHtml(s.genre)} · ${ts}</div></div><div class="hist-actions"><button class="btn-sm" onclick="loadFromHistory(${s.id})">${_t("btn.load", "Load")}</button><button class="btn-sm" onclick="exportSong(${s.id})">${_t("nav.export", "Export")}</button><button class="btn-sm danger" onclick="deleteFromHistory(${s.id})">x</button></div></div>`;
                    })
                    .join("");
            }
            function loadFromHistory(id) {
                const song = history.find((s) => s.id === id);
                if (!song) return;
                currentSong = song;
                applyHistorySettings(song);
                renderSongCard(song);
                renderChordsCard(song);

                // If lyrics were in the history, switch to lyrics tab to show them
                if (song.settings?.userLyrics?.content) {
                    switchLTab("lyrics");
                }

                switchRTab("output");
            }
            function deleteFromHistory(id) {
                history = history.filter((s) => s.id !== id);
                persistHistory();
                renderHistory();
            }
            function clearHistory() {
                if (!confirm(_t("alert.clear_history", "Clear all saved songs?"))) return;
                history = [];
                persistHistory();
                renderHistory();
            }

            // ========================================================================
            // History Backup and Restore
            // ========================================================================
            function exportHistoryBackup() {
                if (history.length === 0) {
                    alert(_t("alert.no_history", "No songs in history to backup."));
                    return;
                }

                // Update song count in modal
                document.getElementById("backup-song-count").textContent = history.length;

                // Reset checkbox
                document.getElementById("backup-include-api").checked = false;

                // Show modal
                document.getElementById("backup-modal").style.display = "flex";
            }

            function closeBackupModal(e) {
                if (!e || e.target.id === "backup-modal") {
                    document.getElementById("backup-modal").style.display = "none";
                }
            }

            function confirmHistoryBackup() {
                const includeAPI = document.getElementById("backup-include-api").checked;

                const backupData = {
                    version: "1.0",
                    backupDate: new Date().toISOString(),
                    songCount: history.length,
                    songs: history.map((song) => ({
                        ...song,
                        // Ensure we capture the saved date
                        savedAt: song.savedAt || new Date().toISOString(),
                    })),
                };

                // Optionally include API key
                if (includeAPI) {
                    const apiKey = localStorage.getItem("gemini_api_key");
                    if (apiKey) {
                        backupData.apiKey = apiKey;
                    }
                    const orKey = localStorage.getItem("openrouter_api_key");
                    if (orKey) {
                        backupData.openrouterKey = orKey;
                    }
                    // Always save model selection alongside keys
                    backupData.selectedModel = document.getElementById("model-select")?.value || selectedModel;
                    backupData.activeApiProvider = activeApiProvider;
                }

                // JSON replacer that strips hidden control characters during stringification
                // Keeps newlines (\n), carriage returns (\r), and tabs (\t) intact — these are
                // valid in JSON string values and are needed for lyrics formatting.
                const cleanReplacer = (key, value) => {
                    if (typeof value === "string") {
                        // Remove only truly problematic non-printable control chars; preserve \t \n \r
                        return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
                    }
                    return value;
                };

                const backupText = [
                    "SUNOFORGE HISTORY BACKUP",
                    "",
                    `Backup Date: ${new Date().toLocaleString()}`,
                    `Songs: ${backupData.songCount}`,
                    includeAPI ? "API Key: Included (PLAIN TEXT - SECURE THIS FILE!)" : "API Key: Not included",
                    "",
                    "This backup contains all your saved songs and can be imported",
                    "into SunoForge to restore your history.",
                    "",
                    "--- SUNOFORGE HISTORY BACKUP ---",
                    JSON.stringify(backupData, cleanReplacer, 2),
                ].join("\n");

                // Download the backup file
                const a = document.createElement("a");
                const timestamp = new Date().toISOString().split("T")[0];
                const filename = `SunoForge_Backup_${timestamp}.txt`;
                a.href = "data:text/plain;charset=utf-8," + encodeURIComponent(backupText);
                a.download = filename;
                a.click();

                // Close modal
                closeBackupModal();

                // Show confirmation
                alert(`Backup exported successfully!\n\nFile: ${filename}\nSongs: ${backupData.songCount}${includeAPI ? "\n\nAPI Key included - Please secure this file!" : ""}`);
            }

            function importHistoryBackup(content) {
                try {
                    // Extract JSON data
                    const jsonMarker = "--- SUNOFORGE HISTORY BACKUP ---";

                    const jsonIndex = content.indexOf(jsonMarker);

                    if (jsonIndex === -1) {
                        throw new Error("Invalid backup file format - marker not found");
                    }

                    // Extract everything after the marker
                    let jsonText = content.substring(jsonIndex + jsonMarker.length);

                    // Remove all leading whitespace and newlines
                    jsonText = jsonText.replace(/^\s+/, "");

                    // Find the first { which marks the start of JSON
                    const jsonStart = jsonText.indexOf("{");
                    if (jsonStart === -1) {
                        throw new Error("No JSON object found in backup file");
                    }

                    // Extract from the first { onwards
                    jsonText = jsonText.substring(jsonStart);

                    // Parse the JSON with error handling
                    let backupData;
                    try {
                        backupData = safeParseJSON(jsonText);
                    } catch (parseError) {
                        // Try to fix common issues: remove problematic control characters
                        // Keep: tab (0x09), newline (0x0A), carriage return (0x0D)
                        // Remove: other control chars (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F)
                        const cleanedText = jsonText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
                        try {
                            backupData = safeParseJSON(cleanedText);
                        } catch (cleanError) {
                            throw new Error("Invalid JSON in backup file: " + parseError.message);
                        }
                    }

                    if (!backupData.version || !backupData.songs || !Array.isArray(backupData.songs)) {
                        throw new Error("Invalid backup data structure");
                    }

                    // Import songs - always merge, never replace existing
                    const importedSongs = backupData.songs.map((song, idx) => ({
                        ...song,
                        id: Date.now() + idx, // Ensure unique IDs
                        savedAt: song.savedAt || new Date().toISOString(),
                    }));

                    // Merge: add imported songs, remove duplicates by title+genre, keep most recent
                    const combined = [...history, ...importedSongs];
                    const uniqueMap = new Map();

                    combined.forEach((song) => {
                        const key = `${song.title}|${song.genre}`;
                        const existing = uniqueMap.get(key);

                        if (!existing || new Date(song.savedAt) > new Date(existing.savedAt)) {
                            uniqueMap.set(key, song);
                        }
                    });

                    history = Array.from(uniqueMap.values()).sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

                    // Import API key if present
                    let apiKeyRestored = false;
                    // Stash target model/provider before fetches so refreshCombinedModelList picks them up
                    if (backupData.selectedModel) {
                        selectedModel = backupData.selectedModel;
                        localStorage.setItem("selected_model", backupData.selectedModel);
                    }
                    if (backupData.activeApiProvider) {
                        activeApiProvider = backupData.activeApiProvider;
                        localStorage.setItem("active_api_provider", backupData.activeApiProvider);
                    }
                    if (backupData.apiKey) {
                        localStorage.setItem("gemini_api_key", backupData.apiKey);
                        document.getElementById("api-key-input").value = backupData.apiKey;
                        aiClient = new GoogleGenAI({ apiKey: backupData.apiKey });
                        const st = document.getElementById("api-status");
                        st.textContent = _t("status.ready", "ready");
                        st.className = "api-status ok";
                        document.getElementById("api-no-key-hint").style.display = "none";
                        fetchGoogleModels(backupData.apiKey);
                        apiKeyRestored = true;
                    }
                    if (backupData.openrouterKey) {
                        localStorage.setItem("openrouter_api_key", backupData.openrouterKey);
                        document.getElementById("openrouter-key-input").value = backupData.openrouterKey;
                        const ost = document.getElementById("openrouter-status");
                        ost.textContent = _t("status.ready", "ready");
                        ost.className = "api-status ok";
                        document.getElementById("api-no-key-hint").style.display = "none";
                        fetchOpenRouterModels(backupData.openrouterKey);
                        apiKeyRestored = true;
                    }

                    // Persist and render
                    persistHistory();
                    renderHistory();

                    // Show success message
                    const msg = ["Backup imported successfully!", "", `Songs from backup: ${importedSongs.length}`, `Total songs in history: ${history.length}`, "", "(Duplicates merged, most recent versions kept)"];

                    if (backupData.apiKey) msg.push("", "Google AI Studio key restored");
                    if (backupData.openrouterKey) msg.push("OpenRouter key restored");
                    if (backupData.selectedModel) msg.push(`Model restored: ${backupData.selectedModel}`);

                    alert(msg.join("\n"));

                    // Switch to history tab
                    switchRTab("history");
                } catch (err) {
                    console.error("Backup import error:", err);
                    alert(_fmt("alert.import_backup_error", "Failed to import backup file. Please make sure it's a valid SunoForge backup file.\n\nError: {0}", err.message));
                }
            }

            function importFromFile() {
                document.getElementById("import-file-input").click();
            }

            function handleImportFile(event) {
                const file = event.target.files[0];
                if (!file) return;

                const reader = new FileReader();
                reader.onload = function (e) {
                    try {
                        const content = e.target.result;

                        // Check if this is a history backup file
                        if (content.includes("--- SUNOFORGE HISTORY BACKUP ---")) {
                            importHistoryBackup(content);
                        } else {
                            // Single song import
                            const song = parseImportedSong(content);
                            if (song) {
                                // Add to history
                                history.unshift({ ...song, savedAt: new Date().toISOString(), id: Date.now() });
                                persistHistory();
                                renderHistory();

                                // Load the imported song
                                currentSong = song;
                                applyHistorySettings(song);
                                renderSongCard(song);
                                renderChordsCard(song);

                                // If lyrics were imported, switch to lyrics tab to show them
                                if (song.settings?.userLyrics?.content) {
                                    switchLTab("lyrics");
                                }

                                switchRTab("output");
                            }
                        }
                    } catch (err) {
                        console.error("Import error:", err);
                        alert(_t("alert.import_file_error", "Failed to import file. Please make sure it's a valid SunoForge export file."));
                    }
                };
                reader.readAsText(file);
                // Reset the input so the same file can be imported again
                event.target.value = "";
            }

            function parseImportedSong(text) {
                // Check for JSON data block first
                const jsonMarker = "--- SUNOFORGE JSON DATA ---";
                const jsonIndex = text.indexOf(jsonMarker);

                if (jsonIndex !== -1) {
                    // Extract and parse JSON data
                    try {
                        const jsonText = text.substring(jsonIndex + jsonMarker.length).trim();
                        const jsonData = JSON.parse(jsonText);

                        if (jsonData.version && jsonData.song) {
                            // Use JSON data directly
                            const song = jsonData.song;

                            // Ensure settings exist and populate userLyrics if sections exist
                            if (!song.settings) {
                                song.settings = {};
                            }

                            // Convert sections to bulk lyrics format if not already in settings
                            if (!song.settings.userLyrics && song.sections && song.sections.length > 0) {
                                const bulkLyrics = song.sections
                                    .map((section) => {
                                        let sectionText = `[${section.type}]`;
                                        if (section.direction) {
                                            sectionText += `\n[${section.direction}]`;
                                        }
                                        if (section.instructions) {
                                            sectionText += `\n[${section.instructions}]`;
                                        }
                                        if (section.lines) {
                                            sectionText += `\n${section.lines}`;
                                        }
                                        return sectionText;
                                    })
                                    .join("\n\n")
                                    .trim();

                                if (bulkLyrics) {
                                    song.settings.userLyrics = { mode: "bulk", content: bulkLyrics };
                                    song.settings.aiMode = song.settings.aiMode || "keep";
                                }
                            }

                            return song;
                        }
                    } catch (err) {
                        console.warn("Failed to parse JSON data, falling back to text parsing:", err);
                        // Fall through to legacy text parsing
                    }
                }

                // Legacy text parsing (fallback)
                const lines = text.split("\n");
                const song = {
                    sections: [],
                    soundProfile: {},
                    key_info: {},
                    settings: {},
                };

                let currentSection = null;
                let inLyrics = false;
                let inProduction = false;
                let inChords = false;
                let inSoundProfile = false;
                let currentLyricSection = null;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();

                    // Stop parsing if we hit the JSON data block
                    if (line === "--- SUNOFORGE JSON DATA ---") {
                        break;
                    }

                    // Parse header fields
                    if (line.startsWith("SONG: ")) {
                        song.title = line.substring(6).trim();
                    } else if (line.startsWith("Genre: ")) {
                        song.genre = line.substring(7).trim();
                    } else if (line.startsWith("Concept: ")) {
                        song.concept = line.substring(9).trim();
                    } else if (line.startsWith("Vocal Configuration: ")) {
                        const vocalText = line.substring(21).trim();
                        song.vocalProfiles = parseVocalConfiguration(vocalText);
                    } else if (line.startsWith("Tempo Preference: ")) {
                        song.tempoPreference = line.substring(18).trim();
                    } else if (line.startsWith("Verse Length: ")) {
                        song.verseLength = line.substring(14).trim();
                    } else if (line.startsWith("Chorus Length: ")) {
                        song.chorusLength = line.substring(15).trim();
                    } else if (line.startsWith("Instrument Exclusions: ")) {
                        const exclusions = line.substring(23).trim();
                        song.instrumentExclusions = exclusions === "--" ? "" : exclusions;
                    } else if (line.startsWith("Structure: ")) {
                        song.structureName = line.substring(11).trim();
                    } else if (line.startsWith("Key: ")) {
                        const keyInfo = line.substring(5).trim();
                        const parts = keyInfo.split(" · ");
                        if (parts.length >= 4) {
                            song.key_info.key = parts[0] !== "--" ? parts[0] : null;
                            song.key_info.time_sig = parts[1] !== "--" ? parts[1] : null;
                            song.key_info.tempo = parts[2] !== "--" ? parts[2] : null;
                            song.key_info.feel = parts[3] !== "--" ? parts[3] : null;
                        }
                    } else if (line.startsWith("Suno Style Prompt: ")) {
                        const stylePrompt = line.substring(19).trim();
                        song.suno_style_prompt = stylePrompt === "--" ? "" : stylePrompt;
                    } else if (line === "--- SOUND PROFILE ---") {
                        inSoundProfile = true;
                        inProduction = false;
                        inChords = false;
                        inLyrics = false;
                    } else if (line === "--- PRODUCTION NOTES ---") {
                        inProduction = true;
                        inSoundProfile = false;
                        inChords = false;
                        inLyrics = false;
                        song.production = "";
                    } else if (line === "--- CHORD PROGRESSION ---") {
                        inChords = true;
                        inProduction = false;
                        inSoundProfile = false;
                        inLyrics = false;
                        song.chords = { progression: "" };
                    } else if (line === "--- LYRICS ---") {
                        inLyrics = true;
                        inProduction = false;
                        inChords = false;
                        inSoundProfile = false;
                    } else if (inSoundProfile && line) {
                        // Parse sound profile fields
                        if (line.startsWith("Era: ")) {
                            song.soundProfile.eras = line
                                .substring(5)
                                .split(",")
                                .map((s) => s.trim());
                        } else if (line.startsWith("Style: ")) {
                            song.soundProfile.styles = line
                                .substring(7)
                                .split(",")
                                .map((s) => s.trim());
                        } else if (line.startsWith("Instrumentation: ")) {
                            song.soundProfile.insts = line
                                .substring(17)
                                .split(",")
                                .map((s) => s.trim());
                        } else if (line.startsWith("Mix: ")) {
                            song.soundProfile.mixes = line
                                .substring(5)
                                .split(",")
                                .map((s) => s.trim());
                        } else if (line.startsWith("Influences: ")) {
                            song.soundProfile.infs = line
                                .substring(12)
                                .split(",")
                                .map((s) => s.trim());
                        }
                    } else if (inProduction && line && !line.startsWith("---")) {
                        song.production += (song.production ? "\n" : "") + line;
                    } else if (inChords && line && !line.startsWith("---")) {
                        if (line !== "--") {
                            song.chords.progression += (song.chords.progression ? "\n" : "") + line;
                        }
                    } else if (inLyrics && line) {
                        // Parse lyrics sections
                        const sectionMatch = line.match(/^\[(.+?)\]$/);
                        if (sectionMatch) {
                            const sectionContent = sectionMatch[1];
                            const sectionType = sectionContent.toLowerCase();

                            // Skip [Style: ...] opening tag and closing ]
                            if (sectionType.startsWith("style:") || sectionType === "]") {
                                continue;
                            }

                            // Check if this is a known section type (with optional numbers like "Verse 1")
                            const isKnownSection = /^(intro|verse|pre-?chorus|chorus|post-?chorus|bridge|outro|hook|refrain|interlude|instrumental|solo|breakdown|drop|build|coda|tag|ending)(\s+\d+)?$/i.test(sectionType);

                            // If we have a current section and this looks like a meta tag (not a known section type)
                            if (currentLyricSection && !isKnownSection) {
                                // If we haven't set direction yet, this is the direction tag
                                if (!currentLyricSection.direction) {
                                    currentLyricSection.direction = sectionContent;
                                } else if (!currentLyricSection.instructions) {
                                    // If direction is set but instructions is not, this is instructions
                                    currentLyricSection.instructions = sectionContent;
                                }
                            } else if (isKnownSection) {
                                // This is a new section
                                currentLyricSection = {
                                    type: sectionContent,
                                    lines: "",
                                    direction: null,
                                    instructions: null,
                                };
                                song.sections.push(currentLyricSection);
                            }
                        } else if (currentLyricSection && line && !line.startsWith("---")) {
                            currentLyricSection.lines += (currentLyricSection.lines ? "\n" : "") + line;
                        }
                    } else if (!song.logline && i > 0 && i < 10 && line && !line.startsWith("Genre:") && !line.startsWith("SONG:")) {
                        // Try to capture logline from early lines
                        if (!song.logline) song.logline = line;
                    }
                }

                // Convert sections to bulk lyrics format
                let bulkLyrics = "";
                if (song.sections && song.sections.length > 0) {
                    bulkLyrics = song.sections
                        .map((section) => {
                            let sectionText = `[${section.type}]`;
                            if (section.direction) {
                                sectionText += `\n[${section.direction}]`;
                            }
                            if (section.instructions) {
                                sectionText += `\n[${section.instructions}]`;
                            }
                            if (section.lines) {
                                sectionText += `\n${section.lines}`;
                            }
                            return sectionText;
                        })
                        .join("\n\n")
                        .trim();
                }

                // Fill in settings from parsed data
                song.settings = {
                    title: song.title,
                    concept: song.concept || song.logline || "",
                    genreKey: currentGenreKey,
                    genreLabel: song.genre,
                    mood: null,
                    rhyme: null,
                    tempo: song.tempoPreference,
                    musicalKey: song.key_info?.key || "Auto",
                    timeSignature: song.key_info?.time_sig || "4/4",
                    pov: null,
                    vocalProfiles: song.vocalProfiles,
                    verseLength: song.verseLength,
                    chorusLength: song.chorusLength,
                    structure: song.structureName ? { name: song.structureName } : null,
                    soundProfile: song.soundProfile,
                    lyricsMode: "single",
                    aiMode: bulkLyrics ? "keep" : "complete",
                    userLyrics: bulkLyrics ? { mode: "bulk", content: bulkLyrics } : null,
                    instrumentExclusions: song.instrumentExclusions,
                };

                return song;
            }

            function parseVocalConfiguration(vocalText) {
                if (!vocalText || vocalText === "Not specified") return null;

                // Parse formats like:
                // "Single: Male, baritone, American"
                // "Duet: Female (soprano, British) + Male (tenor, American)"
                // "Group: 3 voices"

                const result = { type: "single", profiles: [] };

                if (vocalText.startsWith("Single:")) {
                    result.type = "single";
                    const config = vocalText.substring(7).trim();
                    const parts = config.split(",").map((s) => s.trim());
                    result.profiles = [
                        {
                            gender: parts[0] || "Male",
                            range: parts[1] || null,
                            accents: parts.slice(2).filter((a) => a),
                        },
                    ];
                } else if (vocalText.startsWith("Duet:")) {
                    result.type = "duet";
                    const config = vocalText.substring(5).trim();
                    // Parse "Female (soprano, British) + Male (tenor, American)"
                    const vocalists = config.split("+").map((s) => s.trim());
                    result.profiles = vocalists.map((v) => {
                        const match = v.match(/(\w+)\s*\(([^)]+)\)/);
                        if (match) {
                            const gender = match[1];
                            const details = match[2].split(",").map((s) => s.trim());
                            return {
                                gender: gender,
                                range: details[0] || null,
                                accents: details.slice(1).filter((a) => a),
                            };
                        }
                        return { gender: v, range: null, accents: [] };
                    });
                } else if (vocalText.startsWith("Group:")) {
                    result.type = "group";
                    const match = vocalText.match(/(\d+)\s*voices/);
                    const count = match ? parseInt(match[1]) : 3;
                    result.profiles = Array(count)
                        .fill(null)
                        .map(() => ({
                            gender: "Mixed",
                            range: null,
                            accents: [],
                        }));
                }

                return result;
            }

            // ========================================================================
            // Export Functions
            // Generates and exports song data in various formats
            // ========================================================================
            let exportText = "";
            let exportLyricsText = "";
            let exportStylePromptText = "";
            let exportSongTitleText = "";
            let exportExclusionsText = "";
            function exportSong(id) {
                const song = id ? history.find((s) => s.id === id) : currentSong;
                if (!song) return;
                exportSongTitleText = song.title || "Untitled";
                exportExclusionsText = song.instrumentExclusions || "";
                const sp = song.soundProfile;
                const tempoPreference = formatTempoPreference(song.tempoPreference || song.settings?.tempo || "AI Choose");
                const vocalConfig = song.vocalProfiles ? formatVocalProfilesForPrompt(song.vocalProfiles) : song.vocalGender ? formatVocalGenderValue(song.vocalGender) : "Not specified";
                const verseLength = formatLengthPreference(song.verseLength);
                const chorusLength = formatLengthPreference(song.chorusLength);

                // Build style details with proper formatting
                const styleDetailsLines = [];

                // Main details section
                if (vocalConfig && vocalConfig !== "Not specified") styleDetailsLines.push(`Vocal: ${vocalConfig}`);
                if (song.mood) styleDetailsLines.push(`Mood: ${song.mood}`);
                if (song.goal && song.goal !== "Not specified") styleDetailsLines.push(`Goal: ${song.goal}`);
                if (song.rhythm && song.rhythm !== "AI Choose") styleDetailsLines.push(`Rhythm: ${song.rhythm}`);
                if (song.grooveFeel && song.grooveFeel !== "AI Choose") styleDetailsLines.push(`Groove Feel: ${song.grooveFeel}`);
                if (song.pov) styleDetailsLines.push(`Perspective: ${song.pov}`);
                if (tempoPreference && tempoPreference !== "AI Choose" && tempoPreference !== "Auto") styleDetailsLines.push(`Tempo Preference: ${tempoPreference}`);
                // Only include verse/chorus length if not "Follow Structure"
                if (verseLength && verseLength !== "Follow Structure") styleDetailsLines.push(`Verse Length: ${verseLength}`);
                if (chorusLength && chorusLength !== "Follow Structure") styleDetailsLines.push(`Chorus Length: ${chorusLength}`);
                if (sp?.eras?.length) styleDetailsLines.push(`Era: ${sp.eras.join(", ")}`);
                if (sp?.styles?.length) styleDetailsLines.push(`Production style: ${sp.styles.join(", ")}`);
                if (sp?.instruments?.length) styleDetailsLines.push(`Instruments: ${sp.instruments.join(", ")}`);
                if (sp?.insts?.length) styleDetailsLines.push(`Instrumentation: ${sp.insts.join(", ")}`);
                if (sp?.bass && sp.bass !== "AI Choose") styleDetailsLines.push(`Bass: ${sp.bass}`);
                if (sp?.spatial?.length) styleDetailsLines.push(`Spatial/Effects: ${sp.spatial.join(", ")}`);
                // Instrument exclusions removed from style prompt - now has dedicated button

                // Mix section with blank line before it
                if (sp?.mixes?.length) {
                    styleDetailsLines.push("");
                    styleDetailsLines.push(`Mix: ${sp.mixes.join(", ")}`);
                }

                // Production notes with blank line before it
                if (song.production) {
                    styleDetailsLines.push("");
                    styleDetailsLines.push(`Production notes: ${song.production}`);
                }

                // Chord progression with blank line before it
                if (song.chords?.progression) {
                    styleDetailsLines.push("");
                    styleDetailsLines.push(`Chord progression: ${song.chords.progression}`);
                }

                exportStylePromptText = song.suno_style_prompt || "--";
                exportLyricsText = buildAssembledLyricsPrompt(song);
                debugLog("EXPORT_COMPLETE", "Export lyrics built", {
                    totalLength: exportLyricsText.length,
                    preview: exportLyricsText.substring(0, 500),
                });
                const spLines = sp
                    ? [
                          ``,
                          `--- SOUND PROFILE ---`,
                          sp.eras?.length ? `Era: ${sp.eras.join(", ")}` : "",
                          sp.styles?.length ? `Style: ${sp.styles.join(", ")}` : "",
                          sp.instruments?.length ? `Instruments: ${sp.instruments.join(", ")}` : "",
                          sp.insts?.length ? `Instrumentation: ${sp.insts.join(", ")}` : "",
                          sp.mixes?.length ? `Mix: ${sp.mixes.join(", ")}` : "",
                          sp.bass && sp.bass !== "AI Choose" ? `Bass: ${sp.bass}` : "",
                          sp.spatial?.length ? `Spatial/Effects: ${sp.spatial.join(", ")}` : "",
                          sp.infs?.length ? `Influences: ${sp.infs.join(", ")}` : "",
                      ].filter((x) => x !== undefined && x !== null)
                    : "";
                // Create JSON export data for reliable import
                const jsonExportData = {
                    version: "1.0",
                    song: {
                        title: song.title,
                        logline: song.logline,
                        genre: song.genre,
                        mood: song.mood,
                        goal: song.goal,
                        rhythm: song.rhythm,
                        grooveFeel: song.grooveFeel,
                        rhyme: song.rhyme,
                        concept: song.concept,
                        structureName: song.structureName,
                        production: song.production,
                        suno_style_prompt: song.suno_style_prompt,
                        style_meta_tag: song.style_meta_tag,
                        instrumentExclusions: song.instrumentExclusions,
                        tempoPreference: song.tempoPreference,
                        verseLength: song.verseLength,
                        chorusLength: song.chorusLength,
                        vocalProfiles: song.vocalProfiles,
                        soundProfile: song.soundProfile,
                        key_info: song.key_info,
                        chords: song.chords,
                        sections: song.sections,
                        settings: song.settings,
                    },
                };

                const exportLines = [`SONG: ${song.title}`, `${song.logline}`, ``, `Genre: ${song.genre}`];

                if (song.concept) exportLines.push(`Concept: ${song.concept}`);

                if (vocalConfig && vocalConfig !== "Not specified") exportLines.push(`Vocal Configuration: ${vocalConfig}`);
                if (tempoPreference && tempoPreference !== "AI Choose" && tempoPreference !== "Auto") exportLines.push(`Tempo Preference: ${tempoPreference}`);

                const verseLengthExp = formatLengthPreference(song.verseLength);
                const chorusLengthExp = formatLengthPreference(song.chorusLength);
                if (verseLengthExp && verseLengthExp !== "Follow Structure") exportLines.push(`Verse Length: ${verseLengthExp}`);
                if (chorusLengthExp && chorusLengthExp !== "Follow Structure") exportLines.push(`Chorus Length: ${chorusLengthExp}`);

                if (song.instrumentExclusions) exportLines.push(`Instrument Exclusions: ${song.instrumentExclusions}`);
                if (song.structureName) exportLines.push(`Structure: ${song.structureName}`);

                // Only include Key info if it has meaningful values (not all defaults)
                const hasKeyInfo =
                    (song.key_info?.key && song.key_info.key !== "--" && song.key_info.key !== "Auto") ||
                    (song.key_info?.time_sig && song.key_info.time_sig !== "--" && song.key_info.time_sig !== "Auto") ||
                    (song.key_info?.tempo && song.key_info.tempo !== "--") ||
                    (song.key_info?.feel && song.key_info.feel !== "--");
                if (hasKeyInfo) {
                    exportLines.push(`Key: ${song.key_info?.key || "--"} · ${song.key_info?.time_sig || "--"} · ${song.key_info?.tempo || "--"} · ${song.key_info?.feel || "--"}`);
                }

                if (song.suno_style_prompt) exportLines.push(`Suno Style Prompt: ${song.suno_style_prompt}`);

                if (Array.isArray(spLines) && spLines.length > 0) exportLines.push(...spLines);

                exportLines.push(``, `--- PRODUCTION NOTES ---`, song.production, ``, `--- CHORD PROGRESSION ---`, song.chords?.progression || "--", ``, `--- LYRICS ---`, exportLyricsText, ``, ``, `--- SUNOFORGE JSON DATA ---`, JSON.stringify(jsonExportData, null, 2));

                exportText = exportLines.join("\n");
                // Show/hide exclusions button based on whether there are exclusions
                const exclusionsBtn = document.getElementById("copy-exclusions-btn");
                if (exclusionsBtn) {
                    exclusionsBtn.style.display = exportExclusionsText ? "inline-block" : "none";
                }

                document.getElementById("export-modal").style.display = "flex";
            }
            function closeExport(e) {
                if (e.target.id === "export-modal") closeModal();
            }
            function closeModal() {
                document.getElementById("export-modal").style.display = "none";
            }
            function openAnalyzerModal() {
                document.getElementById("analyzer-modal").style.display = "flex";
            }
            function closeAnalyzerModal(e) {
                if (!e || e.target.id === "analyzer-modal") {
                    document.getElementById("analyzer-modal").style.display = "none";
                }
            }
            function downloadTxt() {
                const a = document.createElement("a");
                a.href = "data:text/plain;charset=utf-8," + encodeURIComponent(exportText);
                a.download = (currentSong?.title || "song").replace(/\s+/g, "_") + ".txt";
                a.click();
            }
            function copyExport() {
                navigator.clipboard.writeText(exportText).then(() => {
                    const btn = document.getElementById("copy-export-btn");
                    btn.textContent = "Copied!";
                    setTimeout(() => (btn.textContent = "Copy"), 2000);
                });
            }
            function copyStylePromptExport() {
                navigator.clipboard.writeText(exportStylePromptText).then(() => {
                    const btn = document.getElementById("copy-style-btn");
                    btn.textContent = "Copied!";
                    setTimeout(() => (btn.textContent = "Copy Style Prompt"), 2000);
                });
            }
            function removeDoubleBrackets(text) {
                // Remove double round brackets (()) and double square brackets [[]]
                return text.replace(/\(\(/g, "(").replace(/\)\)/g, ")").replace(/\[\[/g, "[").replace(/\]\]/g, "]");
            }
            function normalizeLyricsText(text) {
                // Remove one or more blank lines immediately after any [tag] or (tag) line.
                // Covers blank lines between consecutive tags and between a tag and lyrics.
                text = text.replace(/^([ \t]*[\[(][^\]\)\n]+[\]\)])[ \t]*\n((?:[ \t]*\n)+)/gm, "$1\n");
                // Collapse 3+ consecutive newlines down to 2 (one blank line between sections)
                text = text.replace(/\n{3,}/g, "\n\n");
                return text.trim();
            }
            function copyLyricsExport() {
                const cleanedLyrics = removeDoubleBrackets(exportLyricsText);
                navigator.clipboard.writeText(cleanedLyrics).then(() => {
                    const btn = document.getElementById("copy-lyrics-btn");
                    btn.textContent = "Copied!";
                    setTimeout(() => (btn.textContent = "Copy Lyrics"), 2000);
                });
            }
            function copySongTitleExport() {
                navigator.clipboard.writeText(exportSongTitleText).then(() => {
                    const btn = document.getElementById("copy-title-btn");
                    btn.textContent = "Copied!";
                    setTimeout(() => (btn.textContent = "Copy Song Title"), 2000);
                });
            }
            function copyExclusionsExport() {
                navigator.clipboard.writeText(exportExclusionsText).then(() => {
                    const btn = document.getElementById("copy-exclusions-btn");
                    btn.textContent = "Copied!";
                    setTimeout(() => (btn.textContent = "Copy Exclusions"), 2000);
                });
            }

            // ========================================================================
            // Regenerate Section
            // Allows regenerating individual song sections with AI
            // ========================================================================
            async function regenSection(idx, btn) {
                if (!currentSong) return;
                btn.textContent = "...";
                btn.classList.add("loading");
                btn.disabled = true;
                const sec = currentSong.sections[idx];
                const currentSoundProfile = currentSong.soundProfile ? soundProfilePromptText(currentSong.soundProfile) : "None specified";
                const currentProductionNotes = currentSong.production || "None available";
                const currentChordProgression = currentSong.chords?.progression || "None available";
                const currentTempoPreference = formatTempoPreference(currentSong.tempoPreference || getSelectedTempoPreference());
                const currentVerseLength = formatLengthPreference(currentSong.verseLength || getSelectedVerseLength());
                const currentChorusLength = formatLengthPreference(currentSong.chorusLength || getSelectedChorusLength());
                const vocalConfig = currentSong.vocalProfiles ? formatVocalProfilesForPrompt(currentSong.vocalProfiles) : "Not specified";
                const currentKey = currentSong.key_info?.key || "Unknown";
                const instrumentExclusions = currentSong.instrumentExclusions || getInstrumentExclusions();
                const regenLang = currentSong.settings?.songLanguage || getSongLanguage();

                const prompt = `You are a professional songwriter. Rewrite ONLY this section with fresh, original lyrics.
                Song: ${currentSong.title} | Genre: ${currentSong.genre} | Rhyme: ${currentSong.rhyme || "AABB"}${vocalConfig !== "Not specified" ? `\nVocal Configuration: ${vocalConfig}` : ""}${currentTempoPreference !== "AI Choose" ? `\nTempo Preference: ${currentTempoPreference}` : ""}\nLyrics Language: ${regenLang}
                Verse Length Preference: ${currentVerseLength}
                Chorus Length Preference: ${currentChorusLength}${instrumentExclusions ? `\nInstrument Exclusions: ${instrumentExclusions}` : ""}
                Section: ${sec.type}
                Current:\n${sec.lines}
                Structure: ${currentSong.structureName || "Unknown"}${currentKey !== "Unknown" && currentKey !== "Auto" ? `\nKey: ${currentKey}` : ""}
                Sound Profile:\n${currentSoundProfile}
                Production Notes:\n${currentProductionNotes}
                Chord Progression:\n${currentChordProgression}
                Also return a Suno-compatible style prompt for the overall song. The "suno_style_prompt" must be 1000 characters or less total. If the full style prompt would exceed that limit, put the overflow or extra detail into "style_meta_tag" so it can be inserted at the start of the returned lyrics.
                The returned Suno style prompt must incorporate all current settings and song-defining details: Genre, Structure, Key, full Sound Profile, Production Notes, and Chord Progression.
                If verse or chorus length preference is set to Follow Structure, keep the natural section length implied by the selected structure and song style.
                Respond ONLY with JSON (no backticks): {"lines":"new lyrics","direction":"short direction","suno_style_prompt":"max 1000 chars","style_meta_tag":"optional [Style: ...]"}`;
                try {
                    debugLog("SECTION_REGEN_REQUEST", `Regenerating section: ${sec.type}`, {
                        promptLength: prompt.length,
                        prompt: prompt,
                        sectionType: sec.type,
                        currentLines: sec.lines,
                    });
                    const response = await callAI(prompt);
                    const raw = response.text.replace(/```json|```/g, "").trim();
                    debugLog("SECTION_REGEN_RESPONSE", `Received regenerated section: ${sec.type}`, {
                        responseLength: raw.length,
                        rawResponse: raw,
                    });
                    const parsed = safeParseJSON(raw);
                    debugLog("SECTION_REGEN_PARSED", `Parsed regenerated section: ${sec.type}`, parsed);
                    currentSong.sections[idx].lines = stripAllLeadingMetaTags(stripLeadingStyleMetaTag(parsed.lines));
                    currentSong.sections[idx].direction = parsed.direction
                        ? parsed.direction
                              .trim()
                              .replace(/^\[|\]$/g, "")
                              .trim()
                        : "";
                    if (parsed.suno_style_prompt) currentSong.suno_style_prompt = parsed.suno_style_prompt;
                    currentSong.style_meta_tag = parsed.style_meta_tag || currentSong.style_meta_tag || "";
                    applySunoStylePromptData(currentSong);
                    renderSongCard(currentSong);
                } catch (e) {
                    alert(_fmt("alert.regen_failed", "Regen failed: {0}", e.message));
                }
                btn.textContent = _t("btn.regen", "Regen");
                btn.classList.remove("loading");
                btn.disabled = false;
            }

            // ========================================================================
            // Edit Section Functions
            // Allows manual editing of lyric sections
            // ========================================================================
            // Copy generated lyrics back to Lyrics tab
            function copyLyricsToTab() {
                if (!currentSong || !currentSong.sections || currentSong.sections.length === 0) {
                    alert("No lyrics to copy. Generate a song first.");
                    return;
                }
                document.getElementById("lyrics-copy-confirm-modal").style.display = "flex";
            }
            function closeLyricsCopyConfirm() {
                document.getElementById("lyrics-copy-confirm-modal").style.display = "none";
            }
            function confirmCopyLyricsToTab() {
                closeLyricsCopyConfirm();
                // Format lyrics per section (normalize each section individually so the regex
                // never sees section boundaries — s.type is the reliable section header).
                const formattedLyrics = currentSong.sections
                    .map((s) => {
                        const strippedLines = stripAllLeadingMetaTags(s.lines || "");
                        const metaTagLines = collectSectionMetaTags(s)
                            .map((tag) => `\n[${tag}]`)
                            .join("");
                        return normalizeLyricsText(`[${s.type}]${metaTagLines}\n${strippedLines}`);
                    })
                    .join("\n\n");

                // Populate the lyrics input
                const lyricsInput = document.getElementById("lyrics-input");
                if (lyricsInput) {
                    lyricsInput.value = formattedLyrics;
                    switchLTab("lyrics");
                } else {
                    alert("Could not find lyrics input field.");
                }
            }
            window.copyLyricsToTab = copyLyricsToTab;
            window.closeLyricsCopyConfirm = closeLyricsCopyConfirm;
            window.confirmCopyLyricsToTab = confirmCopyLyricsToTab;

            function applySettingsFromAIResult() {
                const song = currentSong;
                if (!song) return;

                const s = song.settings || {};

                // Collect all values to be applied
                const genreKey = s.genreKey || "rock";
                const genreLabel = s.genreLabel || song.genre || "";
                const title = song.title || s.title || "";
                const mood = song.mood || s.mood || "";
                const goal = song.goal || s.goal || "";
                const rhythm = song.rhythm || s.rhythm || "";
                const grooveFeel = song.grooveFeel || s.grooveFeel || "";
                const rhyme = song.rhyme || s.rhyme || "";
                const pov = s.pov || "";
                const tempo = song.key_info?.tempo || song.tempoPreference || s.tempo || "AI Choose";
                const musicalKey = song.key_info?.key || s.musicalKey || "Auto";
                const timeSignature = song.key_info?.time_sig || s.timeSignature || "Auto";
                const structureData = s.structure || (song.structureName ? { name: song.structureName } : null);
                const vp = song.vocalProfiles || s.vocalProfiles;
                const sp = song.soundProfile || s.soundProfile;
                const instrExcl = song.instrumentExclusions || s.instrumentExclusions || "";
                const concept = song.concept || s.concept || "";

                // Build confirmation summary
                const lines = ["The following settings will be applied:", ""];
                if (genreLabel) lines.push("Genre: " + genreLabel);
                if (title) lines.push("Title: " + title);
                if (concept) lines.push("Concept: " + concept);
                if (mood) lines.push("Mood: " + mood);
                if (goal && goal !== "Not specified") lines.push("Goal: " + goal);
                if (rhythm && rhythm !== "AI Choose") lines.push("Rhythm: " + rhythm);
                if (grooveFeel && grooveFeel !== "AI Choose") lines.push("Groove Feel: " + grooveFeel);
                if (rhyme) lines.push("Rhyme Scheme: " + rhyme);
                if (pov) lines.push("Perspective: " + pov);
                lines.push("Tempo: " + tempo);
                lines.push("Musical Key: " + musicalKey);
                lines.push("Time Signature: " + timeSignature);
                if (structureData?.name) lines.push("Structure: " + structureData.name);
                if (vp?.type) lines.push("Vocal: " + vp.type);
                if (song.verseLength || s.verseLength) lines.push("Verse Length: " + (song.verseLength || s.verseLength));
                if (song.chorusLength || s.chorusLength) lines.push("Chorus Length: " + (song.chorusLength || s.chorusLength));
                if (sp) {
                    if (sp.eras?.length) lines.push("Era: " + sp.eras.join(", "));
                    if (sp.styles?.length) lines.push("Production Style: " + sp.styles.join(", "));
                    if (sp.instruments?.length) lines.push("Instruments: " + sp.instruments.join(", "));
                    if (sp.insts?.length) lines.push("Instrumentation: " + sp.insts.join(", "));
                    if (sp.bass) lines.push("Bass: " + sp.bass);
                    if (sp.spatial?.length) lines.push("Spatial/Effects: " + sp.spatial.join(", "));
                    if (sp.mixes?.length) lines.push("Mix: " + sp.mixes.join(", "));
                    if (sp.infs?.length) lines.push("Influences: " + sp.infs.join(", "));
                }
                if (instrExcl) lines.push("Instrument Exclusions: " + instrExcl);

                openSettingsConfirm(lines.join("\n")).then(function (confirmed) {
                    if (!confirmed) return;

                    // Genre (must come first — drives structure list)
                    applyGenreSetting(genreKey, genreLabel);

                    // Title
                    document.getElementById("title").value = title;

                    // Concept
                    document.getElementById("concept").value = concept;

                    // Mood / Goal / Rhythm / Groove / Rhyme / POV
                    if (mood) applySingleTagOrCustom("mood-tags", mood, "mood-custom-row", "mood-custom-tag", "Custom mood");
                    if (goal && goal !== "Not specified") applySingleTagOrCustom("goal-tags", goal, "goal-custom-row", "goal-custom-tag", "Custom goal");
                    if (rhythm && rhythm !== "AI Choose") applySingleTagOrCustom("rhythm-tags", rhythm, "rhythm-custom-row", "rhythm-custom-tag", "Custom rhythm");
                    if (grooveFeel && grooveFeel !== "AI Choose") applySingleTagOrCustom("groove-tags", grooveFeel, "groove-custom-row", "groove-custom-tag", "Custom groove feel");
                    if (rhyme) applyRhymeSetting(rhyme);
                    if (pov) applySingleTagOrCustom("pov-tags", pov, "pov-custom-row", "pov-custom-tag", "Custom perspective");

                    // Tempo
                    applyTempoPreference(tempo);

                    // Musical Key
                    document.getElementById("musical-key").value = normalizeMusicalKey(musicalKey);

                    // Time Signature
                    const timeSignatureSelect = document.getElementById("time-signature");
                    const timeSignatureCustom = document.getElementById("time-signature-custom");
                    const tsPresets = ["Auto", "4/4", "3/4", "2/4", "6/8", "5/4", "7/4", "9/8", "12/8"];
                    if (tsPresets.includes(timeSignature)) {
                        timeSignatureSelect.value = timeSignature;
                    } else {
                        timeSignatureSelect.value = "Custom";
                        timeSignatureCustom.value = timeSignature;
                    }
                    toggleTimeSignatureMode();

                    // Structure
                    if (structureData) applySavedStructure(structureData, currentGenreKey);

                    // Vocal Profiles
                    restoreVocalProfiles(vp || null);

                    // Verse / Chorus Length
                    document.getElementById("verse-length-select").value = song.verseLength || s.verseLength || "";
                    document.getElementById("chorus-length-select").value = song.chorusLength || s.chorusLength || "";

                    // Sound Profile
                    if (sp) {
                        applyMultiTagValues("era-tags", sp.eras || []);
                        applyMultiTagValues("prodstyle-tags", sp.styles || []);
                        applyMultiTagValues("instruments-tags", sp.instruments || []);
                        applyMultiTagValues("inst-tags", sp.insts || []);
                        applyMultiTagValues("mix-tags", sp.mixes || []);
                        applySingleTagOrCustom("bass-tags", sp.bass || "", "bass-custom-row", "bass-custom-tag", "Custom bass");
                        applyMultiTagValues("spatial-tags", sp.spatial || []);
                        influences = [];
                        renderInfluenceChips();
                        (sp.infs || []).forEach(function (inf) {
                            addInfluenceVal(inf);
                        });
                    }

                    // Instrument Exclusions
                    document.getElementById("instrument-exclude").value = instrExcl;

                    // Switch to settings tab
                    switchLTab("settings");
                });
            }
            window.applySettingsFromAIResult = applySettingsFromAIResult;

            // ========================================================================
            // Render Output Cards
            // Creates HTML card displays for song output, chords, and metadata
            // ========================================================================
            function renderSongCard(song) {
                const panel = document.getElementById("tab-output");
                document.getElementById("empty-state").style.display = "none";
                const old = document.getElementById("main-song-card");
                if (old) old.remove();
                const ts = new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" }) + " · " + new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
                const kiRows = song.key_info
                    ? Object.entries(song.key_info)
                          .map(([k, v]) => `<div class="key-item"><span class="key-k">${escapeHtml(k.replace(/_/g, " "))}:</span><span class="key-v">${escapeHtml(v)}</span></div>`)
                          .join("")
                    : "";
                const sp = song.soundProfile;
                let spHtml = "";
                if (sp && (sp.eras?.length || sp.styles?.length || sp.insts?.length || sp.mixes?.length || sp.infs?.length)) {
                    const pills = [
                        ...(sp.eras || []).map((v) => `<span class="sound-pill sp-era">${escapeHtml(v.split("(")[0].trim())}</span>`),
                        ...(sp.styles || []).map((v) => `<span class="sound-pill sp-style">${escapeHtml(v.split("-")[0].trim())}</span>`),
                        ...(sp.insts || []).map((v) => `<span class="sound-pill sp-inst">${escapeHtml(v.split("-")[0].trim())}</span>`),
                        ...(sp.mixes || []).map((v) => `<span class="sound-pill sp-mix">${escapeHtml(v.split("-")[0].trim())}</span>`),
                        ...(sp.infs || []).map((v) => `<span class="sound-pill sp-inf">~ ${escapeHtml(v)}</span>`),
                    ].join("");
                    spHtml = `<div class="sound-pills">${pills}</div>`;
                }
                const lyricsHtml = song.sections
                    .map((sec, i) => {
                        const cls = sectionClass(sec.type, sec.userProvided);
                        const userBadge = sec.userProvided ? `<span class="user-badge">yours</span>` : "";
                        const regenBtn = sec.userProvided ? "" : `<button class="btn-regen" onclick="regenSection(${i},this)">${_t("btn.regen", "Regen")}</button>`;
                        const actionBtns = `<span id="section-actions-${i}">${regenBtn}</span>`;
                        // Build the full exportable content for this section so the
                        // textarea always matches exactly what will go to Suno.
                        const sectionMetaTags = collectSectionMetaTags(sec);
                        const metaLines = sectionMetaTags.map((tag) => `[${tag}]`).join("\n");
                        let editableText = `[${sec.type}]` + (metaLines ? `\n${metaLines}` : "");
                        const lyricsBody = stripAllLeadingMetaTags(sec.lines || "").trim();
                        if (lyricsBody) editableText += `\n${lyricsBody}`;
                        return `<div class="lyric-section" id="section-${i}"><div class="lyric-label ${cls}"><span><span id="section-type-label-${i}">${escapeHtml(sec.type)}</span>${userBadge}</span>${actionBtns}</div><textarea id="section-textarea-${i}" class="section-edit-ta" spellcheck="false">${escapeHtml(editableText)}</textarea></div>`;
                    })
                    .join('<div class="sec-div"></div>');
                const allLyrics = buildAssembledLyricsPrompt(song);
                const sunoStylePrompt = song.suno_style_prompt || "--";
                const card = document.createElement("div");
                card.className = "output-card";
                card.id = "main-song-card";
                card.innerHTML = `
                    <div class="card-header">
                      <div style="margin-bottom:8px;text-align:center;">
                        <button class="btn-copy" onclick="applySettingsFromAIResult()">${_t("btn.update_card", "Update Settings")}</button>
                      </div>
                      <div class="card-header-row"><div>
                      <div class="card-title">${escapeHtml(song.title)}</div>
                      <div class="card-subtitle">${escapeHtml(song.logline)}</div>
                      <div class="genre-badge ${badgeClass(song.genre)}">${escapeHtml(song.genre)}</div>
                      ${song.structureName ? `<div style="font-size:9px;color:var(--text-muted);font-family:'Space Mono',monospace;margin-top:3px;">Structure: ${escapeHtml(song.structureName)}</div>` : ""}
                      ${spHtml}
                      <div class="card-meta" style="margin-top:4px;">${ts}</div>
                    </div></div></div>
                        <div class="block">
                            <div class="block-header"><div class="section-header">${_t("section.suno_style", "Suno Style Prompt")}</div><button class="btn-copy" onclick="copyText(this,\`${escapeAttr(sunoStylePrompt).replace(/`/g, "\\`")}\`)">Copy</button></div>
                            <div class="prod-body">${escapeHtml(sunoStylePrompt)}</div><div class="char-count">${sunoStylePrompt === "--" ? 0 : sunoStylePrompt.length} / 1000 chars</div>
                        </div>
                    <div class="block">
                      <div class="block-header"><div class="section-header">${_t("section.prod_notes", "Production Notes")}</div><button class="btn-copy" onclick="copyText(this,\`${escapeAttr(song.production).replace(/`/g, "\\`")}\`)">Copy</button></div>
                      <div class="prod-grid"><div><div class="prod-body">${escapeHtml(song.production)}</div><div class="char-count">${song.production.length} chars</div></div><div><div class="key-box">${kiRows}</div></div></div>
                    </div>
                    <div class="block">
                      <div class="block-header"><div class="section-header">${_t("section.lyrics", "Lyrics")}</div><button class="btn-copy" onclick="copyLyricsToTab()">${_t("btn.copy_to_lyrics", "Copy to Lyrics Tab")}</button><span id="lyrics-char-count" class="char-count" style="margin-top:0;margin-left:4px;">${allLyrics.length} characters</span><button class="btn-copy" onclick="copyText(this,\`${escapeAttr(allLyrics).replace(/`/g, "\\`")}\`)">Copy All</button></div>
                      <div class="lyrics-content">${lyricsHtml}</div>
                    </div>`;
                panel.insertBefore(card, panel.firstChild);
                switchRTab("output");
                requestAnimationFrame(function () {
                    initSectionTextareas(song);
                });

                // Show export button when song is rendered
                const exportBtn = document.getElementById("export-btn");
                if (exportBtn) exportBtn.style.display = "block";
            }

            function initSectionTextareas(song) {
                song.sections.forEach(function (sec, idx) {
                    const ta = document.getElementById("section-textarea-" + idx);
                    if (!ta) return;
                    ta.style.height = "auto";
                    ta.style.height = ta.scrollHeight + "px";
                    ta.addEventListener("input", function () {
                        this.style.height = "auto";
                        this.style.height = this.scrollHeight + "px";
                        const rawLines = this.value.split("\n");
                        let sectionType = currentSong.sections[idx].type;
                        const metaTags = []; // all bracket lines after the type tag
                        const lyricLines = [];
                        let firstLine = true;
                        for (let i = 0; i < rawLines.length; i++) {
                            const trimmed = rawLines[i].trim();
                            const match = trimmed.match(/^\[([^\]]+)\]$/);
                            if (match && firstLine && isLikelySectionTag(match[1])) {
                                sectionType = match[1].trim();
                                firstLine = false;
                            } else if (match) {
                                metaTags.push(match[1].trim());
                                firstLine = false;
                            } else {
                                if (trimmed) firstLine = false;
                                lyricLines.push(rawLines[i]);
                            }
                        }
                        currentSong.sections[idx].type = sectionType;
                        // Store in metaTags so collectSectionMetaTags uses them directly.
                        // Keep direction/instructions in sync for backward-compat with export paths.
                        currentSong.sections[idx].metaTags = metaTags;
                        currentSong.sections[idx].direction = metaTags[0] || "";
                        currentSong.sections[idx].instructions = metaTags.slice(1).join("\n");
                        currentSong.sections[idx].lines = lyricLines.join("\n").trim();
                        const typeLabel = document.getElementById("section-type-label-" + idx);
                        if (typeLabel) {
                            typeLabel.textContent = sectionType;
                            const labelDiv = typeLabel.closest(".lyric-label");
                            if (labelDiv) labelDiv.className = "lyric-label " + sectionClass(sectionType, currentSong.sections[idx].userProvided);
                        }
                        const histEntry = history.find(function (s) {
                            return s.id === currentSong.id;
                        });
                        if (histEntry) {
                            histEntry.sections = currentSong.sections;
                            persistHistory();
                        }
                        const charCountEl = document.getElementById("lyrics-char-count");
                        if (charCountEl) charCountEl.textContent = buildAssembledLyricsPrompt(currentSong).length + " chars";
                    });
                });
            }

            function renderChordsCard(song) {
                const panel = document.getElementById("tab-chords");
                document.getElementById("chords-empty").style.display = "none";
                const old = document.getElementById("chords-card");
                if (old) old.remove();
                if (!song.chords) return;
                const c = song.chords;
                const chordCardsHtml = (c.chords || []).map((ch) => `<div class="chord-card"><div class="chord-name">${escapeHtml(ch.name)}</div><div class="chord-role">${escapeHtml(ch.role)}</div></div>`).join("");
                const card = document.createElement("div");
                card.className = "output-card";
                card.id = "chords-card";
                card.innerHTML = `
                    <div class="card-header"><div class="card-title" style="font-size:16px;">${escapeHtml(song.title)} &#8212; Chord Chart</div><div class="card-meta" style="margin-top:5px;">Key of ${escapeHtml(song.key_info?.key || "?")} · ${escapeHtml(song.key_info?.feel || "")}</div></div>
                    <div class="block"><div class="section-header" style="margin-bottom:8px;">${_t("section.core_chords", "Core Chords")}</div><div class="chord-grid">${chordCardsHtml}</div></div>
                    <div class="block"><div class="block-header"><div class="section-header">${_t("section.progression", "Progression")}</div><button class="btn-copy" onclick="copyText(this,\`${escapeAttr(c.progression || "").replace(/`/g, "\\`")}\`)">Copy</button></div><div class="chord-prog">${escapeHtml(c.progression || "")}</div></div>
                    ${c.notes ? `<div class="block"><div class="section-header" style="margin-bottom:6px;">${_t("section.harmonic_notes", "Harmonic Notes")}</div><div class="prod-body">${escapeHtml(c.notes)}</div></div>` : ""}`;
                panel.insertBefore(card, panel.firstChild);
            }

            // ========================================================================
            // Generate Song - Main AI generation function
            // ========================================================================
            async function generateSong() {
                const enablePostGenerationLengthChecks = true;
                const titleInput = document.getElementById("title").value.trim();
                const title = titleInput || "";
                const conceptRaw = document.getElementById("concept").value.trim();
                const concept = conceptRaw;
                const specialInstructions = document.getElementById("special-instructions").value.trim();
                const genre = getSelectedGenreLabel();
                const mood = getSelectedMood();
                const goal = getSelectedGoal();
                const rhythm = getSelectedRhythm();
                const grooveFeel = getSelectedGrooveFeel();
                const rhyme = getSelectedRhymeScheme();
                const tempo = getSelectedTempoPreference();
                const duration = getDurationPreference();
                const selectedMusicalKey = getSelectedMusicalKey();
                const selectedTimeSignature = getSelectedTimeSignature();
                const pov = getSelectedPov();
                const accent = getSelectedAccent();
                const songLanguage = getSongLanguage();
                const verseLength = getSelectedVerseLength();
                const chorusLength = getSelectedChorusLength();
                const struct = selectedStructure || (GENRE_STRUCTURES[currentGenreKey] || DEFAULT_STRUCTURES)[0];
                const soundProfile = buildSoundProfile();
                const userLyrics = getUserLyrics();
                const aiMode = activeLeftTab === "lyrics" ? getActive("aimode-tags") : null;
                const isKeepMode = (aiMode === "keep" || aiMode === "redir") && userLyrics?.mode === "bulk";
                const keepModeSections = isKeepMode ? parseKeepModeSectionsFromBulkLyrics(userLyrics.content) : [];
                const keepModeHasClearSections = !isKeepMode || keepModeSections.length > 0;

                // Validate: at least a genre or concept must be provided
                if (!genre && !conceptRaw) {
                    document.getElementById("validation-modal-msg").textContent = _t("alert.validation_song", "Please select at least one Genre or enter a Concept / Story before writing your song.");
                    document.getElementById("validation-modal").style.display = "flex";
                    return;
                }

                if (isKeepMode && !keepModeHasClearSections) {
                    const proceedAfterWarning = await openKeepModeWarningModal();
                    if (!proceedAfterWarning) return;
                }
                const submissionSummary = buildSubmissionSummary({
                    title,
                    concept,
                    specialInstructions,
                    genre,
                    mood,
                    goal,
                    rhythm,
                    grooveFeel,
                    rhyme,
                    tempo,
                    duration,
                    selectedMusicalKey,
                    selectedTimeSignature,
                    pov,
                    accent,
                    verseLength,
                    chorusLength,
                    struct,
                    soundProfile,
                    aiMode,
                    userLyrics,
                    songLanguage,
                });
                const confirmed = await openSubmitConfirm(submissionSummary);
                if (!confirmed) return;

                const genBtn = document.getElementById("gen-btn");
                if (genBtn) {
                    genBtn.disabled = true;
                    genBtn.innerHTML = `<span class="spin">...</span> ${_t("btn.writing", "Writing...")}`;
                }

                const panel = document.getElementById("tab-output");
                document.getElementById("empty-state").style.display = "none";
                switchRTab("output");

                let lyricsInstruction = "";
                if (userLyrics) {
                    const modeLabels = {
                        complete: "Complete the song around these lyrics verbatim",
                        rewrite: "Use these lyrics as inspiration only - completely rewrite them using the concept/story, sound settings, and influences to create entirely new lyrics that fit the specified structure",
                        match: "Generate new lyrics matching the voice/style of these example lyrics",
                        fit: "Fit these lyrics into the requested structure",
                        keep: "Keep my current lyrics exactly as provided",
                        redir: "Keep my current lyrics exactly as provided — generate fresh section directions based on current song settings",
                    };
                    const modeDesc = modeLabels[aiMode] || "Use these as a foundation";

                    // Modes that preserve user lyrics should keep meta tags
                    const preservesLyrics = ["keep", "complete", "fit"].includes(aiMode);
                    const metaTagInstruction = preservesLyrics
                        ? ` IMPORTANT: Preserve ALL meta tags and bracketed instructions exactly as written. This includes square brackets [] and parentheses () that contain performance directions, vocal effects, or any other production notes. Do not strip, remove, or modify these tags - they are intentional parts of the lyrics.`
                        : "";

                    if (userLyrics.mode === "bulk") {
                        lyricsInstruction = `\n\nUSER LYRICS (${modeDesc}):\n"""\n${userLyrics.content}\n"""\nMark sections using user lyrics with "userProvided":true.${metaTagInstruction}`;
                        if (aiMode === "keep") {
                            lyricsInstruction += ` Preserve the supplied lyrics exactly as written, including every bracketed section label, every inline or standalone meta tag, and every line break exactly where the user placed them. Meta tags that appear after the first section tag must remain in the same section and in the same order. Do not rewrite, merge, normalize, or remove any supplied lyric text or tags.`;
                        } else if (aiMode === "redir") {
                            lyricsInstruction += ` CRITICAL: Keep ALL lyric body text verbatim — do not change, rewrite, or remove any lyric lines. However, you MUST generate FRESH, NEW section directions and instructions for each section based on the current song settings, genre, mood, style, and sound profile. Do NOT copy or preserve any existing direction or instruction meta tags from the user-provided lyrics. The "direction" and "instructions" JSON fields for every section must be entirely newly generated by you to reflect the current song settings.`;
                        } else if (aiMode === "rewrite") {
                            lyricsInstruction += ` Completely rewrite these lyrics from scratch. Draw inspiration from the themes and ideas, but create entirely new lines that align with the concept/story, sound profile, and influences specified. Ensure the new lyrics fit the selected song structure perfectly.`;
                        } else if (aiMode === "fit") {
                            lyricsInstruction += ` IMPORTANT: Reorganize and adapt these lyrics to fit the requested song structure (${struct.name} -- ${struct.flow}). You may need to split, combine, or rearrange lyric sections to match the structure flow exactly. Preserve the core lyric content and meaning, but adjust phrasing, line breaks, and section placement as needed to fit the structure. If lyrics are insufficient for all sections, generate new lines in the same style to complete the structure. Mark original lyrics with "userProvided":true and any newly generated sections with "userProvided":false.`;
                        } else if (aiMode === "match") {
                            lyricsInstruction += ` CRITICAL: The provided lyrics are EXAMPLES ONLY to demonstrate the desired writing style, voice, tone, vocabulary, and phrasing. You MUST write COMPLETELY NEW lyrics for all sections following the requested structure (${struct.name} -- ${struct.flow}). Study the example lyrics carefully to understand the voice and style, then create fresh, original lyrics that sound like they were written by the same artist but tell the story through the concept/theme provided. DO NOT reuse any lines from the example lyrics. All sections should be marked "userProvided":false since you are generating new content.`;
                        }
                    } else {
                        const sl = Object.entries(userLyrics.content)
                            .map(([k, v]) => `[${k}]:\n${v}`)
                            .join("\n\n");
                        lyricsInstruction = `\n\nUSER LYRICS BY SECTION (${modeDesc}):\n"""\n${sl}\n"""\nFor user-provided sections mark "userProvided":true. For blank sections write original lyrics${aiMode === "match" ? " matching the user's voice" : ""}.${metaTagInstruction}`;
                        if (aiMode === "keep") {
                            lyricsInstruction += ` Keep every provided section exactly as written. Preserve every meta tag and bracketed instruction inside each supplied section exactly where it appears. Only generate missing sections if required by the selected structure.`;
                        } else if (aiMode === "redir") {
                            lyricsInstruction += ` CRITICAL: Keep ALL lyric body text verbatim — do not change any lyric lines. However, you MUST generate FRESH, NEW section directions and instructions for each section based on the current song settings, genre, mood, style, and sound profile. Do NOT copy or preserve any existing direction or instruction tags from the provided sections. The "direction" and "instructions" JSON fields must be entirely newly generated.`;
                        } else if (aiMode === "rewrite") {
                            lyricsInstruction += ` Completely rewrite all sections from scratch. Draw inspiration from the themes and ideas presented, but create entirely new lines that align with the concept/story, sound profile, and influences specified. Ensure the new lyrics fit the selected song structure perfectly.`;
                        } else if (aiMode === "fit") {
                            lyricsInstruction += ` IMPORTANT: Reorganize and adapt the provided lyric sections to fit the requested song structure (${struct.name} -- ${struct.flow}) exactly. You may need to redistribute lyrics across different section types, split or combine sections, or adjust phrasing to match the structure flow. Preserve the core lyric content from user-provided sections, but adapt them as needed to fit the structure. For any sections in the structure that don't have user lyrics, generate new lines in the same style. Mark sections with original user content as "userProvided":true and newly generated sections as "userProvided":false.`;
                        } else if (aiMode === "match") {
                            lyricsInstruction += ` CRITICAL: For provided sections (non-blank), use them AS-IS and mark "userProvided":true. For BLANK sections, write COMPLETELY NEW, ORIGINAL lyrics that match the voice, style, tone, vocabulary, and phrasing demonstrated in the provided examples. Study the example sections to understand the writing style, then create fresh lyrics that sound like they were written by the same artist. DO NOT copy or reuse lines from the provided sections - generate new content for blank sections and mark them "userProvided":false.`;
                        }
                    }
                }

                const soundInstruction = soundProfile ? `\n\nSOUND PROFILE:\n${soundProfilePromptText(soundProfile)}` : "";

                // Check if influences are enabled (checkbox ticked or influences already specified)
                // Only generate influence descriptions if user wants them
                const influencesCheckbox = document.getElementById("enable-influences-checkbox");
                const influencesEnabled = influencesCheckbox?.checked || false;
                const hasSpecifiedInfluences = soundProfile && soundProfile.infs && soundProfile.infs.length > 0;

                let influenceInstruction = "";
                let expectSuggestedInfluences = false;
                if (hasSpecifiedInfluences) {
                    // User has specified influences - tell AI to convert them to Suno-safe descriptions
                    influenceInstruction = `\n\nCRITICAL - KEY INFLUENCES: The user has specified these influences: ${soundProfile.infs.join(", ")}. For each artist name provided, you MUST convert it to a Suno-safe 4-6 word descriptive phrase that captures that artist's signature sound. DO NOT USE THE ARTIST NAME IN ANY FORM - not with "-esque", "-style", "-inspired", "-like" or any other suffix. ONLY use the descriptive sound characteristics. Examples: "Florence and the Machine" → "orchestral indie pop, ethereal soprano" (NOT "Florence and the Machine-inspired") | "Radiohead" → "experimental alt-rock, atmospheric electronics" (NOT "Radiohead-esque") | "Billie Eilish" → "whispered vocals, dark pop minimalism" (NOT "Billie Eilish-style"). In the suno_style_prompt field, use ONLY the converted descriptive phrases without artist names.`;
                } else if (influencesEnabled) {
                    // Checkbox is ticked but no influences specified - ask AI to suggest some
                    expectSuggestedInfluences = true;
                    influenceInstruction = `\n\nKEY INFLUENCES: Please suggest 3 key musical influences or "sounds like" artist references that would fit this song's genre and style. Return these artist names in a "suggested_influences" array field in the JSON response (e.g., ["Artist Name 1", "Artist Name 2", "Artist Name 3"]). Then, for each artist, convert their style to a Suno-safe 4-6 word descriptive phrase that captures their signature sound characteristics. DO NOT use artist names in the suno_style_prompt - only use the descriptive sound characteristics. Examples: "Florence and the Machine" → "orchestral indie pop, ethereal soprano" | "Radiohead" → "experimental alt-rock, atmospheric electronics" | "Billie Eilish" → "whispered vocals, dark pop minimalism". Include these descriptive phrases in the suno_style_prompt field.`;
                }
                // If neither checkbox is ticked nor influences specified, influenceInstruction remains empty

                const tempoForPrompt = formatTempoPreference(tempo);
                const keyForPrompt = selectedMusicalKey;
                const timeSignatureForPrompt = selectedTimeSignature;
                const vocalConfig = getSelectedVocalGender();
                const isInstrumental = vocalConfig === "Instrumental (no vocals)";

                // Extract chord information from custom structure sequence if available
                let sectionChordsInstruction = "";
                let sectionInstructionsData = "";
                if (struct.sequence && Array.isArray(struct.sequence)) {
                    const sectionChords = struct.sequence
                        .filter((step) => typeof step === "object" && step.chords)
                        .map((step) => `${step.name}: ${step.chords}`)
                        .join(" | ");
                    if (sectionChords) {
                        sectionChordsInstruction = `\n\nSECTION-SPECIFIC CHORDS:\n${sectionChords}\nIncorporate these chord progressions into the corresponding sections. Include these chords in your production notes and chord progression response.`;
                    }

                    const sectionInstructions = struct.sequence
                        .filter((step) => typeof step === "object" && step.instructions)
                        .map((step) => `${step.name}: ${step.instructions}`)
                        .join(" | ");
                    if (sectionInstructions) {
                        sectionInstructionsData = `\n\nSECTION-SPECIFIC INSTRUCTIONS:\n${sectionInstructions}\nThese are performance/production instructions for specific sections. Include them as meta tags in the lyrics for those sections.`;
                    }
                }

                const structureInstruction = isInstrumental
                    ? " This is an INSTRUMENTAL track with NO VOCALS and NO LYRICS. For each section, provide only the section name and a brief performance/arrangement direction. Use placeholder text like '[Musical performance]' or '[Instrumental]' for the lines field."
                    : verseLength || chorusLength
                      ? ` Where specified, write verse sections to approximately ${formatLengthPreference(verseLength)} and chorus sections to approximately ${formatLengthPreference(chorusLength)}, unless user-provided lyrics require otherwise.`
                      : " Let verse and chorus lengths follow the selected structure naturally, unless user-provided lyrics require otherwise.";

                const titleInstruction = title
                    ? `Use the provided title exactly as given: ${title}.`
                    : `Because no title was provided, you must create a compelling song title derived primarily from the ${isInstrumental ? "concept and musical style" : "lyrics and hook, and secondarily from the concept if needed"}. Do not return generic placeholders like Untitled, Song Title, or Title.`;

                const prompt = `You are a professional songwriter and producer with deep expertise in all genres. Also you are master in Suno prompts.

                SONG SPECS:
                Title: ${title || "[Not provided — generate a strong title based on the lyrics, hook, and central idea.]"}
                Concept: ${concept}
                Lyrics Language: ${songLanguage}
                Genre: ${genre}${mood ? `\nMood: ${mood}` : ""}${goal && goal !== "Not specified" ? `\nGoal/Purpose: ${goal}` : ""}${rhythm && rhythm !== "AI Choose" ? `\nRhythm: ${rhythm}` : ""}${grooveFeel && grooveFeel !== "AI Choose" ? `\nGroove Feel: ${grooveFeel}` : ""}${rhyme ? `\nRhyme Scheme: ${rhyme}` : ""}${tempoForPrompt !== "AI Choose" && tempoForPrompt !== "Auto" ? `\nTempo Preference: ${tempoForPrompt}` : ""}${duration ? `\nTarget Duration: ${duration}` : ""}${keyForPrompt !== "Auto" ? `\nRequested Musical Key: ${keyForPrompt}` : ""}${timeSignatureForPrompt !== "Auto" ? `\nRequested Time Signature: ${timeSignatureForPrompt}` : ""}${pov ? `\nPerspective: ${pov}` : ""}${vocalConfig !== "Not specified" ? `\nVocal Configuration: ${vocalConfig}` : ""}${formatLengthPreference(verseLength) !== "Follow Structure" ? `\nVerse Length Preference: ${formatLengthPreference(verseLength)}` : ""}${formatLengthPreference(chorusLength) !== "Follow Structure" ? `\nChorus Length Preference: ${formatLengthPreference(chorusLength)}` : ""}${getInstrumentExclusions() ? `\nInstrument Exclusions: ${getInstrumentExclusions()}` : ""}
                Structure: ${struct.name} -- ${struct.flow}
                Structure description: ${struct.desc}${sectionChordsInstruction}${sectionInstructionsData}${soundInstruction}${influenceInstruction}${lyricsInstruction}
                Follow the structure flow EXACTLY.${structureInstruction}${tempoForPrompt !== "AI Choose" ? ` Use the requested tempo preference: ${tempoForPrompt}.` : ""}${duration ? ` Target song duration should be ${duration}.` : ""}${keyForPrompt !== "Auto" ? ` Keep the song in ${keyForPrompt}.` : ""}${timeSignatureForPrompt !== "Auto" ? ` Write in ${timeSignatureForPrompt} time signature.` : ""}
                Take in to account these special instructions: ${specialInstructions ? `\nSpecial Instructions: ${specialInstructions}` : "Not specified"}
                LYRICS LANGUAGE: All lyrics must be written exclusively in ${songLanguage}.${songLanguage !== "English" ? ` Do not write any lyrics in English or any other language.` : ""}
                LYRICAL PHRASING TECHNIQUES:
                When generating lyrics, use appropriate phrasing techniques to enhance vocal delivery and expression:
                - Commas within lines create pauses (multiple commas create longer pauses; typically use 1-5 commas where appropriate)
                - Capitalizing the first letter of a word adds emphasis when sung (e.g., "I Never wanted this")
                - ALL CAPITALS forces a word or phrase to be yelled (e.g., "STOP right there")
                Only use these techniques where appropriate to the genre, style, dynamic, and emotional content of the lyrics. Rock, metal, and intense genres may use more emphasis and pauses, while softer genres should use them sparingly for maximum impact.

                ${titleInstruction}
                Also return a Suno-compatible style prompt in "suno_style_prompt". That field must be 1000 characters or less total. If it would exceed 1000 characters, keep "suno_style_prompt" concise and put the overflow or extra style detail in "style_meta_tag", which should be a one-line style meta tag intended for insertion at the start of the returned lyrics.
                LYRICS LENGTH LIMIT: The combined total character count of all "lines" fields across all sections must be 4500 characters or fewer. Count carefully before responding — if the lyrics are too long, shorten lines, reduce repetition, or cut a section. Do not exceed this limit under any circumstances.
                The returned Suno style prompt must incorporate every currently selected setting: Genre, Structure, Key, the full Sound Profile, and it must also reflect the Production Notes and Chord Progression that you return in the same JSON response.
                Respond ONLY with JSON (no markdown, no backticks):
                {
                  "title":"Song title",
                  "logline":"One evocative sentence (20-30 words)",
                  "genre":"${genre}",
                  "structureName":"${struct.name}",
                  "concept":"${concept}",
                  "mood":"${mood}",
                  "rhyme":"${rhyme}",
                    "suno_style_prompt":"Suno-compatible style prompt, max 1000 chars",
                    "vocal_gender":"optional e.g. Male Duo, Female, Choir",
                    "vocal_range":"optional e.g. Tenor, Soprano, Baritone, Contralto",
                    "instrument_exclusions":"optional comma-separated list of instruments to exclude from instrumentation",
                    "suggested_influences":"optional array of 3 artist names if influences were requested, e.g. [\"Artist 1\", \"Artist 2\", \"Artist 3\"]",
                    "key_info":{"key":"${keyForPrompt !== "Auto" ? keyForPrompt : "e.g. E minor"}","time_sig":"${timeSignatureForPrompt !== "Auto" ? timeSignatureForPrompt : "e.g. 4/4"}","tempo":"${tempoForPrompt !== "AI Choose" ? tempoForPrompt : "e.g. 90-110 BPM or 102 BPM"}","feel":"e.g. Straight 8ths"},
                  "production":"400-500 char production description referencing sound profile choices.",
                  "chords":{"chords":[{"name":"Em","role":"Tonic"}],"progression":"Verse: Em-C-G-D | Chorus: C-G-D-Em","notes":"2-3 sentences on harmonic approach."},
                  "sections":[{"type":"Section name","direction":"Performance direction","instructions":"Section-specific instruction","lines":"Lyrics\nLine 2","userProvided":false}]
                }`;

                async function runGeneration(maxLyricsChars, overageChars) {
                    const loadCard = document.createElement("div");
                    loadCard.className = "output-card";
                    loadCard.innerHTML = `<div style="padding:36px;text-align:center;color:var(--text-muted);font-family:'Space Mono',monospace;font-size:11px;">${_t("status.generating", "Writing your song...")}</div>`;
                    panel.insertBefore(loadCard, panel.firstChild);

                    let effectivePrompt = prompt;
                    if (maxLyricsChars !== 4500 && overageChars) {
                        const isKeepMode = aiMode === "keep" || aiMode === "redir";
                        if (isKeepMode) {
                            // Can't shorten user-provided lyrics — shorten production notes/directions instead
                            effectivePrompt = prompt.replace(
                                'LYRICS LENGTH LIMIT: The combined total character count of all "lines" fields across all sections must be 4500 characters or fewer. Count carefully before responding — if the lyrics are too long, shorten lines, reduce repetition, or cut a section. Do not exceed this limit under any circumstances.',
                                `LYRICS LENGTH LIMIT: The previous response was ${overageChars.toLocaleString()} characters over Suno's 5,000-character limit. The user's lyrics are locked and MUST NOT be changed. To reduce the total length, shorten the \"production\" field and reduce the length of section \"direction\" and \"instructions\" fields. The combined total character count of all \"lines\" fields across all sections must be ${maxLyricsChars} characters or fewer, but since lyrics are locked focus on cutting production notes and directions to compensate.`,
                            );
                        } else {
                            effectivePrompt = prompt.replace(
                                'LYRICS LENGTH LIMIT: The combined total character count of all "lines" fields across all sections must be 4500 characters or fewer. Count carefully before responding — if the lyrics are too long, shorten lines, reduce repetition, or cut a section. Do not exceed this limit under any circumstances.',
                                `LYRICS LENGTH LIMIT: The previous response was ${overageChars.toLocaleString()} characters over Suno's 5,000-character limit. The combined total character count of all \"lines\" fields across all sections must be ${maxLyricsChars} characters or fewer. Count carefully before responding — shorten lines, reduce repetition, or cut a section. Do not exceed this limit under any circumstances.`,
                            );
                        }
                    }
                    try {
                        // Log what we're sending to the AI
                        debugLog("SONG_GENERATION_REQUEST", "Sending song generation request to AI", {
                            maxLyricsChars: maxLyricsChars,
                            promptLength: effectivePrompt.length,
                            prompt: effectivePrompt,
                            title: title || "[Not provided]",
                            concept: concept,
                            genre: genre,
                            structure: struct.name,
                        });
                        console.log("=== SENDING TO AI ===");
                        console.log("Max lyrics chars:", maxLyricsChars);
                        console.log("Prompt length:", effectivePrompt.length, "characters");
                        console.log("Full prompt:", effectivePrompt);
                        console.log("====================");

                        const response = await callAI(effectivePrompt);
                        const raw = response.text.replace(/```json|```/g, "").trim();

                        // Log what we received from the AI
                        debugLog("SONG_GENERATION_RESPONSE", "Received song from AI", {
                            responseLength: raw.length,
                            rawResponse: raw,
                        });
                        console.log("=== RECEIVED FROM AI ===");
                        console.log("Raw response length:", raw.length, "characters");
                        console.log("Raw response:", raw);
                        console.log("=======================");

                        const song = safeParseJSON(raw);

                        // Log what we parsed from the AI response
                        debugLog("SONG_GENERATION_PARSED", "Parsed song response", {
                            song: song,
                            sectionsCount: song.sections?.length || 0,
                            sections: song.sections?.map((s) => ({
                                type: s.type,
                                direction: s.direction,
                                instructions: s.instructions,
                                linesLength: s.lines?.length,
                                lines: s.lines,
                                userProvided: s.userProvided,
                            })),
                        });
                        console.log("=== PARSED AI RESPONSE ===");
                        console.log("Parsed song object:", JSON.stringify(song, null, 2));
                        console.log("Sections count:", song.sections?.length || 0);
                        if (song.sections) {
                            song.sections.forEach((section, idx) => {
                                console.log(`Section ${idx}:`, {
                                    type: section.type,
                                    direction: section.direction,
                                    instructions: section.instructions,
                                    linesPreview: section.lines?.substring(0, 200) + (section.lines?.length > 200 ? "..." : ""),
                                    userProvided: section.userProvided,
                                });
                            });
                        }
                        console.log("=========================");

                        // Clean up section lines to remove any meta tags that will be re-added during export
                        // This prevents duplication when the AI preserves user-provided lyrics with meta tags
                        if (!isKeepMode && song.sections && Array.isArray(song.sections)) {
                            song.sections.forEach((section, idx) => {
                                if (section.lines) {
                                    const originalLines = section.lines;
                                    section.lines = stripAllLeadingMetaTags(section.lines);
                                    debugLog("SECTION_CLEANUP", `Stripped meta tags from section ${idx} (${section.type})`, {
                                        original: originalLines,
                                        stripped: section.lines,
                                        removedChars: originalLines.length - section.lines.length,
                                    });
                                }
                            });
                        }

                        if (!titleInput && (!song.title || /^(untitled|song title|title)$/i.test(String(song.title).trim()))) {
                            const fallbackSource = [...(song.sections || [])].map((section) => String(section?.lines || "").trim()).find(Boolean);
                            const fallbackLine = fallbackSource
                                ? fallbackSource
                                      .split(/\r?\n/)
                                      .map((line) => line.trim())
                                      .find((line) => line && !/^\[.*\]$/.test(line) && !/^\(.*\)$/.test(line))
                                : "";
                            song.title = fallbackLine ? fallbackLine.replace(/[.,!?;:]+$/g, "").slice(0, 60) : concept.slice(0, 60);
                        }
                        // Save vocal profiles
                        song.vocalProfiles = getVocalProfiles();
                        song.tempoPreference = formatTempoPreference(tempo);
                        song.durationPreference = duration;
                        song.verseLength = verseLength;
                        song.chorusLength = chorusLength;
                        song.goal = goal;
                        song.rhythm = rhythm;
                        song.grooveFeel = grooveFeel;
                        song.instrumentExclusions = getInstrumentExclusions();

                        // Handle suggested influences from AI
                        if (expectSuggestedInfluences && song.suggested_influences && Array.isArray(song.suggested_influences)) {
                            song.suggested_influences.forEach((artistName) => {
                                const trimmedName = String(artistName || "").trim();
                                if (trimmedName && !influences.includes(trimmedName)) {
                                    addInfluenceVal(trimmedName);
                                }
                            });
                        }

                        // Clean up any section tags and direction tags that AI may have included in the lines
                        // These will be re-added during export from the type and direction fields
                        if (!isKeepMode && Array.isArray(song.sections)) {
                            song.sections.forEach((section) => {
                                if (section.lines) {
                                    section.lines = stripAllLeadingMetaTags(section.lines);
                                }
                                // Strip any wrapping brackets the AI may include in direction/instructions —
                                // these fields get wrapped in [] during export, so pre-existing brackets double up
                                if (section.direction) {
                                    section.direction = section.direction
                                        .trim()
                                        .replace(/^\[|\]$/g, "")
                                        .trim();
                                }
                                if (section.instructions) {
                                    // Strip brackets per-line (not the whole string) so multi-line
                                    // instructions like "[Intro]\n[desc]\n[detail]" are not mangled.
                                    // collectSectionMetaTags > addTag handles per-tag bracket stripping.
                                    section.instructions = section.instructions
                                        .split("\n")
                                        .map((line) =>
                                            line
                                                .trim()
                                                .replace(/^\[|\]$/g, "")
                                                .trim(),
                                        )
                                        .filter(Boolean)
                                        .join("\n");
                                }
                            });

                            // Map instructions from custom structure to sections
                            if (struct.sequence && Array.isArray(struct.sequence)) {
                                song.sections.forEach((section) => {
                                    // Find matching structure step by name
                                    const matchingStep = struct.sequence.find((step) => {
                                        if (typeof step === "object" && step.name && section.type) {
                                            // Normalize both names for comparison
                                            const stepName = step.name.toLowerCase().trim();
                                            const sectionType = section.type.toLowerCase().trim();
                                            return stepName === sectionType || stepName.startsWith(sectionType) || sectionType.startsWith(stepName);
                                        }
                                        return false;
                                    });

                                    // Apply instructions from structure if found and not already set by AI
                                    if (matchingStep && matchingStep.instructions && !section.instructions) {
                                        section.instructions = matchingStep.instructions;
                                    }
                                });
                            }
                        }
                        if (isKeepMode && aiMode === "keep") {
                            song.sections = keepModeSections.map((section) => ({ ...section }));
                            debugLog("KEEP_MODE_OVERRIDE", "Keep mode active: using lyrics from Lyrics tab as source of truth", {
                                sectionCount: song.sections.length,
                                sections: song.sections.map((section) => ({
                                    type: section.type,
                                    direction: section.direction,
                                    instructions: section.instructions,
                                    linesLength: (section.lines || "").length,
                                })),
                            });
                        } else if (aiMode === "redir") {
                            song.sections = mergeRedirSections(song.sections, keepModeSections);
                        } else {
                            song.sections = mergePreservedLyricsSections(song.sections, userLyrics, aiMode);
                        }
                        song.soundProfile = soundProfile;
                        applySunoStylePromptData(song);
                        loadCard.remove();
                        currentSong = song;
                        renderSongCard(song);
                        renderChordsCard(song);
                        saveToHistory(song);

                        if (enablePostGenerationLengthChecks) {
                            const assembledLen = calcAssembledLyricsLength(song);
                            if (assembledLen > 5000) {
                                debugLog("LYRICS_SHORTEN_ACTION", "Assembled lyrics exceeded limit; opening shorten choice modal", {
                                    assembledLength: assembledLen,
                                    limit: 5000,
                                });
                                console.log("[SHORTEN ACTION] Lyrics exceed limit:", assembledLen, "Opening shorten-choice modal.");
                                const choice = await openLyricsTooLongModal(assembledLen);
                                debugLog("LYRICS_SHORTEN_ACTION", "User selected shorten flow option", { choice });
                                console.log("[SHORTEN ACTION] User choice:", choice);
                                if (choice === "ai") {
                                    const shortenCard = document.createElement("div");
                                    shortenCard.className = "output-card";
                                    shortenCard.innerHTML = `<div style="padding:36px;text-align:center;color:var(--text-muted);font-family:'Space Mono',monospace;font-size:11px;">Shortening your song...</div>`;
                                    panel.insertBefore(shortenCard, panel.firstChild);
                                    debugLog("LYRICS_SHORTEN_ACTION", "Inserted shortening status card", {});
                                    console.log("[SHORTEN ACTION] Inserted 'Shortening your song...' status card.");
                                    try {
                                        const shortened = await shortenLyricsPromptWithAI(song);
                                        debugLog("LYRICS_SHORTEN_ACTION", "Shorten flow completed", shortened);
                                        console.log("[SHORTEN ACTION] Shorten result:", shortened);
                                        if (shortened.updated && shortened.length > 5000) {
                                            debugLog("LYRICS_SHORTEN_ACTION", "Shortened result still exceeds limit; showing warning", {
                                                shortenedLength: shortened.length,
                                                limit: 5000,
                                            });
                                            console.log("[SHORTEN ACTION] Shortened lyrics still exceed limit:", shortened.length, "Showing warning modal.");
                                            showLyricsStillTooLongWarning(shortened.length);
                                        }
                                    } catch (shortenErr) {
                                        debugLog("LYRICS_SHORTEN_ACTION", "Shorten flow failed", {
                                            error: shortenErr?.message || String(shortenErr),
                                        });
                                        console.log("[SHORTEN ACTION] Shorten flow failed:", shortenErr);
                                        document.getElementById("validation-modal-msg").textContent = shortenErr.message;
                                        document.getElementById("validation-modal").style.display = "flex";
                                    } finally {
                                        shortenCard.remove();
                                        debugLog("LYRICS_SHORTEN_ACTION", "Removed shortening status card", {});
                                        console.log("[SHORTEN ACTION] Removed shortening status card.");
                                    }
                                }
                            }
                        } else {
                            debugLog("LYRICS_SHORTEN_ACTION", "Post-generation length checks are disabled for this run", {
                                assembledLength: calcAssembledLyricsLength(song),
                                limit: 5000,
                            });
                        }
                    } catch (err) {
                        loadCard.remove();
                        const errCard = document.createElement("div");
                        errCard.className = "output-card";
                        errCard.innerHTML = `<div style="padding:18px;"><div class="section-header" style="margin-bottom:6px;">Error</div><div class="error-box">${escapeHtml(err.message)}</div></div>`;
                        panel.insertBefore(errCard, panel.firstChild);
                    }

                    if (genBtn) {
                        genBtn.disabled = false;
                        genBtn.innerHTML = _t("btn.write_song_label", "Write My Song");
                    }
                } // end runGeneration

                await runGeneration(4500);
            }

            // ========================================================================
            // Global Scope Exposure
            // Expose functions to global scope for inline onclick handlers
            // ========================================================================
            window.saveApiKey = saveApiKey;
            window.saveOpenRouterKey = saveOpenRouterKey;
            window.saveCustomServer = saveCustomServer;
            window.fetchCustomServerModels = fetchCustomServerModels;
            window.setStorageProvider = setStorageProvider;
            window.loginDriveStorage = loginDriveStorage;
            window.connectDriveStorage = connectDriveStorage;
            window.syncDriveStorageNow = syncDriveStorageNow;
            window.disconnectDriveStorage = disconnectDriveStorage;
            window.saveSongLanguageCustom = saveSongLanguageCustom;
            window.toggleApiBar = toggleApiBar;
            window.toggleDebugMode = toggleDebugMode;
            window.switchLTab = switchLTab;
            window.switchRTab = switchRTab;
            window.generateSong = generateSong;
            window.resolveLyricsTooLong = resolveLyricsTooLong;
            window.applyStyle = applyStyle;
            window.applyUnifiedAnalysis = applyUnifiedAnalysis;
            window.openAnalyzerModal = openAnalyzerModal;
            window.closeAnalyzerModal = closeAnalyzerModal;
            window.addInfluence = addInfluence;
            window.removeInfluence = removeInfluence;
            window.setLyricsMode = setLyricsMode;
            window.selectStructure = selectStructure;
            window.selectVocalType = selectVocalType;
            window.applyVocalConfiguration = applyVocalConfiguration;
            window.toggleChoir = toggleChoir;
            window.addStructurePoint = addStructurePoint;
            window.updateStructureStepChords = updateStructureStepChords;
            window.updateStructureStepInstructions = updateStructureStepInstructions;
            window.addCustomStructureBlock = addCustomStructureBlock;
            window.moveCustomStructurePoint = moveCustomStructurePoint;
            window.removeCustomStructurePoint = removeCustomStructurePoint;
            window.undoCustomStructurePoint = undoCustomStructurePoint;
            window.clearCustomStructureBuilder = clearCustomStructureBuilder;
            window.applyCustomStructureBuilder = applyCustomStructureBuilder;
            window.showCustomInput = showCustomInput;
            window.hideCustomInput = hideCustomInput;
            window.confirmCustomTag = confirmCustomTag;
            window.confirmCustomRange = confirmCustomRange;
            window.cancelCustomRange = cancelCustomRange;
            window.toggleTempoMode = toggleTempoMode;
            window.toggleDurationMode = toggleDurationMode;
            window.toggleTimeSignatureMode = toggleTimeSignatureMode;
            window.updateTempoRange = updateTempoRange;
            window.updateDurationRange = updateDurationRange;
            window.removeCustomTag = removeCustomTag;
            window.removeCustomSingleValue = removeCustomSingleValue;
            window.regenSection = regenSection;
            window.exportSong = exportSong;
            window.deleteFromHistory = deleteFromHistory;
            window.closeExport = closeExport;
            window.closeModal = closeModal;
            window.downloadTxt = downloadTxt;
            window.copyExport = copyExport;
            window.copySongTitleExport = copySongTitleExport;
            window.copyStylePromptExport = copyStylePromptExport;
            window.copyLyricsExport = copyLyricsExport;
            window.copyExclusionsExport = copyExclusionsExport;
            window.copyText = copyText;
            window.loadFromHistory = loadFromHistory;
            window.clearHistory = clearHistory;
            window.importFromFile = importFromFile;
            window.handleImportFile = handleImportFile;
            window.resolveSubmitConfirm = resolveSubmitConfirm;
            window.closeSubmitConfirm = closeSubmitConfirm;
            window.resolveKeepModeWarning = resolveKeepModeWarning;
            window.closeKeepModeWarningModal = closeKeepModeWarningModal;
            window.resolveSettingsConfirm = resolveSettingsConfirm;
            window.closeSettingsConfirm = closeSettingsConfirm;
            window.openResetConfirm = openResetConfirm;
            window.closeResetConfirm = closeResetConfirm;
            window.confirmReset = confirmReset;
            window.closeValidationModal = closeValidationModal;
            // Genre selector functions
            window.selectMainGenre = selectMainGenre;
            window.selectSubGenre = selectSubGenre;
            window.addSelectedGenre = addSelectedGenre;
            window.removeSelectedGenre = removeSelectedGenre;
            window.cancelGenreSelection = cancelGenreSelection;
            window.showCustomGenreInput = showCustomGenreInput;
            window.hideCustomGenreInput = hideCustomGenreInput;
            window.confirmCustomGenre = confirmCustomGenre;
            // History backup/restore functions
            window.exportHistoryBackup = exportHistoryBackup;
            window.closeBackupModal = closeBackupModal;
            window.confirmHistoryBackup = confirmHistoryBackup;
            // Model dropdown functions
            window.toggleModelDropdown = toggleModelDropdown;
            window.filterModelOptions = filterModelOptions;
            window.modelFilterKeydown = modelFilterKeydown;
            window.onSongLanguageChange = onSongLanguageChange;
            // Presets
            window.savePreset = savePreset;
            window.loadPreset = loadPreset;
            window.deletePreset = deletePreset;
            window.onPresetSelectChange = onPresetSelectChange;

            // ========================================================================
            // Initialization
            // ========================================================================
            async function initializeApp() {
                loadHistoryFromStorage();
                loadPresetsFromStorage();
                if (storageProvider === STORAGE_PROVIDER_DRIVE && driveClientId) {
                    try {
                        await syncDriveAppState({ interactive: false, showAlert: false });
                    } catch (err) {
                        console.warn("Initial Drive hydrate skipped:", err);
                    }
                }

                renderHistory();
                renderStructureBuilderPalette();
                renderCustomStructureDraft();
                toggleTempoMode();
                toggleDurationMode();
                updateTempoRange();
                updateDurationRange();
                buildStructureList("rock");
                applyStoredSongLanguagePreference();
                updateStorageControls();

                const LOCALE_TO_LANG = { en: "English", de: "German", fr: "French", es: "Spanish", pt: "Portuguese", nl: "Dutch", ru: "Russian", ja: "Japanese", ko: "Korean", "zh-hans": "Chinese (Mandarin)", "zh-hant": "Chinese (Cantonese)" };
                document.getElementById("lang-select")?.addEventListener("change", function () {
                    const mapped = LOCALE_TO_LANG[this.value];
                    if (mapped) {
                        applySongLanguageSetting(mapped);
                        localStorage.setItem("sf_song_lang", mapped);
                    }
                    persistSyncedSettings();
                });

                (function _i18nTagRepeated() {
                    document.querySelectorAll("button.custom-input-confirm").forEach((btn) => {
                        if (!btn.dataset.i18n) btn.dataset.i18n = btn.textContent.trim() === "Set" ? "btn.set" : "btn.add";
                    });
                    document.querySelectorAll("button.custom-input-cancel").forEach((btn) => {
                        if (!btn.dataset.i18n) btn.dataset.i18n = "btn.cancel_x";
                    });
                    document.querySelectorAll("button.tag-add-btn").forEach((btn) => {
                        if (btn.dataset.i18n) return;
                        const txt = btn.textContent.trim();
                        if (txt === "+ Custom") btn.dataset.i18n = "btn.custom";
                        else if (txt === "+ Add") btn.dataset.i18n = "btn.add_influence";
                        else if (txt === "+ Custom Genre") btn.dataset.i18n = "btn.add_custom_genre";
                        else if (txt === "+ Add Block") btn.dataset.i18n = "btn.add_block";
                    });
                })();

                await window.I18N.init();
                updateStorageControls();
            }

            initializeApp();
