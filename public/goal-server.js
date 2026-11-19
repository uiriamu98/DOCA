require("dotenv").config({
    path: require("path").join(__dirname, "..", ".env")
});

const express = require("express");
const io = require("socket.io-client");
const fs = require("fs");
const path = require("path");

const app = express();

console.log("SERVER DIRECTORY:", __dirname);
console.log(
    "ADMIN CSS EXISTS:",
    fs.existsSync(path.join(__dirname, "goal-admin.css"))
);
console.log(
    "ADMIN HTML EXISTS:",
    fs.existsSync(path.join(__dirname, "goal-admin.html"))
);

const PORT = 3000;

const DEFAULT_GOAL_NAME = "New Goal";
const DEFAULT_GOAL_CAD = 100;
const COUNT_FROM = "2026-01-01";

const exchangeRateCache = new Map();

const STREAMLABS_FILE = path.join(__dirname, "streamlabs-donations.json");
const STATE_FILE = path.join(__dirname, "goals-state.json");
const BACKUP_DIR = path.join(__dirname, "goals-backups");
const CUSTOM_SOURCES_FILE = path.join(__dirname, "custom-sources.json");

let streamlabsConnected = false;
let streamlabsDonations = [];
let streamlabsSocket = null;

process.on("unhandledRejection", error => {
    console.error("Unhandled rejection:", error);
});

process.on("uncaughtException", error => {
    console.error("Uncaught exception:", error);
});

function newQueueId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function loadState() {
    const envDa = String(
        process.env.DONATIONALERTS_ENABLED || "false"
    ).toLowerCase() === "true";

    const envSl = String(
        process.env.STREAMLABS_ENABLED || "false"
    ).toLowerCase() === "true";

    if (!fs.existsSync(STATE_FILE)) {
    return {
        targetCurrency: "CAD",
        current: {
            id: "goal_initial",
            name: DEFAULT_GOAL_NAME,
            amount: DEFAULT_GOAL_CAD
        },
            closed: [],
            queue: [],
            sourcesConfig: {
                donatePay: true,
                donationAlerts: envDa,
                streamlabs: envSl
            },
            excludedDonationIds: [],
            goalDonationIds: {},
            manualDonations: {}
        };
    }

    const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

    if (!saved || !saved.current || !Array.isArray(saved.closed)) {
        throw new Error("Invalid goals-state.json");
    }

    if (!Array.isArray(saved.queue)) {
        saved.queue = [];
    }

    if (!Array.isArray(saved.excludedDonationIds)) {
        saved.excludedDonationIds = [];
    }

    if (!saved.current.id) {
        saved.current.id = "goal_initial";
    }

    for (const item of saved.queue) {
        if (!item.id) {
            item.id = newQueueId();
        }
    }

    if (
        !saved.goalDonationIds ||
        typeof saved.goalDonationIds !== "object" ||
        Array.isArray(saved.goalDonationIds)
    ) {
        saved.goalDonationIds = {};
    }

    if (
        !saved.manualDonations ||
        typeof saved.manualDonations !== "object" ||
        Array.isArray(saved.manualDonations)
    ) {
        saved.manualDonations = {};
    }

    /*
     * Ensure every archived donation remains assigned
     * to the goal whose archive contains it.
     */
    for (const goal of saved.closed) {
        if (!goal.id) {
            goal.id = newQueueId();
        }

        for (const donation of goal.donations || []) {
            if (donation.id) {
                saved.goalDonationIds[donation.id] = goal.id;
            }
        }
    }

    if (!saved.sourcesConfig) {
        saved.sourcesConfig = {
            donatePay: true,
            donationAlerts: envDa,
            streamlabs: envSl
        };
    } else {
        if (saved.sourcesConfig.donatePay === undefined) {
            saved.sourcesConfig.donatePay = true;
        }

        if (saved.sourcesConfig.donationAlerts === undefined) {
            saved.sourcesConfig.donationAlerts = envDa;
        }

        if (saved.sourcesConfig.streamlabs === undefined) {
            saved.sourcesConfig.streamlabs = envSl;
        }
    }

    console.log(
        `Loaded goal state: ${saved.closed.length} closed goal(s).`
    );

    console.log(
        `Excluded donations: ${saved.excludedDonationIds.length}`
    );

    return saved;
}

function saveState() {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    if (fs.existsSync(STATE_FILE)) {
        const stamp = new Date()
            .toISOString()
            .replace(/[:.]/g, "-");

        fs.copyFileSync(
            STATE_FILE,
            path.join(BACKUP_DIR, `goals-state-${stamp}.json`)
        );
    }

    const temporaryFile = STATE_FILE + ".tmp";

    fs.writeFileSync(
        temporaryFile,
        JSON.stringify(state, null, 2),
        "utf8"
    );

    fs.renameSync(temporaryFile, STATE_FILE);
}

let state;

try {
    state = loadState();
} catch (error) {
    console.error("Cannot start:", error.message);
    process.exit(1);
}

function closedIdSet() {
    const ids = new Set();

    for (const goal of state.closed) {
        for (const donation of goal.donations || []) {
            ids.add(donation.id);
        }
    }

    return ids;
}

function excludedIdSet() {
    return new Set(state.excludedDonationIds || []);
}

const PUBLIC_FILES = new Set([
    "/",
    "/goal-index.html",
    "/goal-style.css",
    "/goal-script.js",
    "/goal-styleadmin.css"
]);

app.use(express.json());

app.use((req, res, next) => {
    if (
        PUBLIC_FILES.has(req.path) ||
        req.path.startsWith("/Audio/") ||
        req.path.startsWith("/api/") ||
        req.path === "/admin"
    ) {
        return next();
    }

    res.status(404).end();
});

app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "goal-admin.html"));
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "goal-index.html"));
});

app.use(express.static(__dirname));

app.use("/api/admin", (req, res, next) => {
    if (req.get("x-admin") !== "1") {
        return res.status(403).json({ error: "Forbidden" });
    }

    next();
});

function loadStreamlabsDonations() {
    try {
        if (!fs.existsSync(STREAMLABS_FILE)) {
            return [];
        }

        const saved = JSON.parse(
            fs.readFileSync(STREAMLABS_FILE, "utf8")
        );

        if (!Array.isArray(saved)) {
            throw new Error("Invalid saved Streamlabs data");
        }

        console.log(
            `Loaded ${saved.length} saved Streamlabs donation(s).`
        );

        return saved;
    } catch (error) {
        console.error(
            "Could not load Streamlabs donations:",
            error.message
        );

        throw error;
    }
}

function saveStreamlabsDonations() {
    const temporaryFile = STREAMLABS_FILE + ".tmp";

    fs.writeFileSync(
        temporaryFile,
        JSON.stringify(streamlabsDonations, null, 2),
        "utf8"
    );

    fs.renameSync(temporaryFile, STREAMLABS_FILE);
}

if (state.sourcesConfig.streamlabs) {
    try {
        streamlabsDonations = loadStreamlabsDonations();
    } catch (error) {
        process.exit(1);
    }
}

function pickName(object) {
    return String(
        object?.name ??
        object?.username ??
        object?.donor_name ??
        object?.donor ??
        object?.from ??
        object?.nickname ??
        object?.vars?.name ??
        object?.user?.name ??
        object?.user?.username ??
        object?.sender?.name ??
        object?.sender?.username ??
        ""
    );
}

function startStreamlabs() {
    if (!state.sourcesConfig.streamlabs) {
        console.log("Streamlabs: DISABLED");
        return;
    }

    if (streamlabsSocket) {
        return;
    }

    const token = process.env.STREAMLABS_SOCKET_TOKEN;

    if (!token) {
        console.error(
            "Streamlabs: STREAMLABS_SOCKET_TOKEN is missing."
        );
        return;
    }

    streamlabsSocket = io(
        "https://sockets.streamlabs.com",
        {
            query: { token },
            transports: ["websocket"],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 10000
        }
    );

    streamlabsSocket.on("connect", () => {
        streamlabsConnected = true;
        console.log("Streamlabs GOAL socket connected.");
    });

    streamlabsSocket.on("disconnect", () => {
        streamlabsConnected = false;
        console.log("Streamlabs GOAL socket disconnected.");
    });

    streamlabsSocket.on("connect_error", () => {
        streamlabsConnected = false;
        console.error("Streamlabs GOAL connection error.");
    });

    streamlabsSocket.on("error", () => {
        console.error("Streamlabs GOAL socket error.");
    });

    streamlabsSocket.on("event", event => {
        if (!event || event.type !== "donation") {
            return;
        }

        const donations = Array.isArray(event.message)
            ? event.message
            : event.message
                ? [event.message]
                : [];

        for (const donation of donations) {
            if (!donation || typeof donation !== "object") {
                continue;
            }

            const rawId = donation.donation_id ?? donation.id;

            if (
                rawId === undefined ||
                rawId === null ||
                rawId === ""
            ) {
                console.warn(
                    "Streamlabs donation has no ID; skipping."
                );
                continue;
            }

            const id = `sl_${rawId}`;

            if (
                streamlabsDonations.some(item => item.id === id)
            ) {
                continue;
            }

            const amount = Number(donation.amount);
            const currency = String(
                donation.currency || ""
            ).toUpperCase();

            if (
                !Number.isFinite(amount) ||
                amount <= 0 ||
                !/^[A-Z]{3}$/.test(currency)
            ) {
                console.warn(
                    "Streamlabs donation has invalid amount or currency."
                );
                continue;
            }

            const transaction = {
                id,
                amount,
                currency,
                message: String(
                    donation.message ?? donation.comment ?? ""
                ),
                date: new Date().toISOString(),
                name: pickName(donation)
            };

            streamlabsDonations.push(transaction);

            try {
                saveStreamlabsDonations();

                console.log(
                    `Saved Streamlabs donation: ${amount} ${currency}`
                );
            } catch (error) {
                streamlabsDonations.pop();

                console.error(
                    "Could not save Streamlabs donation:",
                    error.message
                );
            }
        }
    });
}

async function getHistoricalRate(fromCurr, toCurr, date) {
    fromCurr = String(fromCurr || "").toLowerCase();
    toCurr = String(toCurr || "cad").toLowerCase();

    if (!fromCurr) {
        throw new Error("Missing donation currency");
    }

    if (fromCurr === toCurr) {
        return 1;
    }

    const cacheKey = `${fromCurr}_${toCurr}_${date}`;

    if (exchangeRateCache.has(cacheKey)) {
        return exchangeRateCache.get(cacheKey);
    }

    const requestedDate = new Date(`${date}T12:00:00Z`);

    for (let attempt = 0; attempt < 7; attempt++) {
        const lookupDate = requestedDate
            .toISOString()
            .slice(0, 10);

        const url =
            `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${lookupDate}/v1/currencies/${fromCurr}.json`;

        try {
            const response = await fetch(url);

            if (response.ok) {
                const data = await response.json();
                const rate = Number(data?.[fromCurr]?.[toCurr]);

                if (Number.isFinite(rate) && rate > 0) {
                    exchangeRateCache.set(cacheKey, rate);
                    return rate;
                }
            }
        } catch (error) {
            console.error(
                `Exchange-rate error for ${lookupDate}:`,
                error.message
            );
        }

        requestedDate.setUTCDate(
            requestedDate.getUTCDate() - 1
        );
    }

    throw new Error(
        `Could not find rate from ${fromCurr.toUpperCase()} to ${toCurr.toUpperCase()} on ${date}`
    );
}

function makeId(prefix, rawId, parts) {
    if (
        rawId !== undefined &&
        rawId !== null &&
        rawId !== ""
    ) {
        return `${prefix}_${rawId}`;
    }

    return `${prefix}_x_${parts
        .map(part => String(part ?? ""))
        .join("|")}`;
}

function pickDonationAlertsName(donation) {
    const username = String(
        donation?.username ?? ""
    ).trim();

    const name = String(
        donation?.name ?? ""
    ).trim();

    const donorName = username || name;

    if (
        !donorName ||
        donorName.toLowerCase() === "anonymous" ||
        (!username && name.toLowerCase() === "donations")
    ) {
        return "Anonymous";
    }

    return donorName;
}

async function donationAlertsTransactions() {
    const token = process.env.DONATIONALERTS_ACCESS_TOKEN;

    if (!token) {
        throw new Error("Missing DONATIONALERTS_ACCESS_TOKEN");
    }

    const donations = [];
    let page = 1;

    while (true) {
        const response = await fetch(
            `https://www.donationalerts.com/api/v1/alerts/donations?page=${page}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json"
                }
            }
        );

        if (!response.ok) {
            throw new Error(
                `DonationAlerts HTTP ${response.status}`
            );
        }

        const result = await response.json();

        if (!Array.isArray(result.data)) {
            throw new Error(
                "Invalid DonationAlerts response"
            );
        }

        donations.push(...result.data);

        const lastPage = Number(result.meta?.last_page);

        if (
            !Number.isInteger(lastPage) ||
            lastPage < 1
        ) {
            throw new Error(
                "DonationAlerts pagination metadata missing"
            );
        }

        if (page >= lastPage) {
            break;
        }

        page++;
    }

    return donations;
}

async function convertDonations(donations, source) {
    const excludedIds = excludedIdSet();

    let total = 0;
    let count = 0;

    const items = [];

    for (const donation of donations) {
        const amount = Number(donation.amount);
        const currency = String(
            donation.currency || "RUB"
        ).toUpperCase();

        let dateStr = String(donation.date || "").trim();
        // Handle alternative date formats like "YYYY-MM-DD HH:mm:ss"
        if (dateStr.includes(" ")) {
            dateStr = dateStr.replace(" ", "T");
        }
        
        let date = dateStr.slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            date = new Date().toISOString().slice(0, 10);
        }

        if (!Number.isFinite(amount) || amount <= 0 || !currency) {
            continue;
        }

        let rate = 1;
        try {
            rate = await getHistoricalRate(currency, state.targetCurrency || "CAD", date);
        } catch (e) {
            rate = 1;
        }

        const convertedAmount = amount * rate;

        let timestamp = Date.parse(donation.date || dateStr);
        if (!Number.isFinite(timestamp)) {
            timestamp = Date.parse(`${date}T12:00:00Z`);
        }

        const included = !excludedIds.has(donation.id);

        if (included) {
            total += convertedAmount;
            count++;
        }

        items.push({
            id: donation.id,
            source,
            name: String(donation.name || "Anonymous"),
            amount,
            currency,
            message: String(donation.message || ""),
            cad: convertedAmount,
            targetAmount: convertedAmount,
            time: String(donation.date || dateStr),
            timestamp,
            included
        });
    }

    return {
        total,
        count,
        items
    };
}

async function getDonatePayTotal() {
    let payloadData = [];
    
    try {
        const response = await fetch("http://localhost:3001/api/transactions", { cache: "no-store" });
        if (response.ok) {
            const payload = await response.json();
            if (Array.isArray(payload.data)) {
                payloadData = payload.data;
            }
        }
    } catch (e) {
        const token = process.env.DONATEPAY_API_TOKEN;
        if (token) {
            try {
                const dpRes = await fetch(`https://donatepay.ru/api/v2/transactions?access_token=${token}`, { cache: "no-store" });
                if (dpRes.ok) {
                    const dpJson = await dpRes.json();
                    if (Array.isArray(dpJson.data)) {
                        payloadData = dpJson.data;
                    }
                }
            } catch (err) {}
        }
    }

    if (payloadData.length === 0) {
        return { total: 0, count: 0, items: [] };
    }

    // Explicitly filter for items where source is explicitly "DonatePay" (ignoring DonationAlerts items in the same feed)
    const donations = payloadData
        .filter(transaction =>
            String(transaction.source || "").toLowerCase() === "donatepay" &&
            (transaction.status === "success" || transaction.status === "active" || transaction.status === undefined) &&
            (transaction.type === "donation" || transaction.sum || transaction.amount)
        )
        .map(transaction => {
            const rawSum = transaction.sum ?? transaction.amount ?? 0;
            const rawCurr = transaction.currency ?? "RUB";
            const rawDate = transaction.created_at ?? transaction.date ?? new Date().toISOString();
            const rawName = transaction.vars?.name ?? transaction.what ?? transaction.name ?? "Anonymous";
            const rawComment = transaction.comment ?? transaction.vars?.comment ?? "";

            return {
                id: makeId("dp", transaction.id, [rawDate, rawSum, rawCurr, rawName]),
                amount: Number(rawSum),
                currency: String(rawCurr).toUpperCase(),
                message: String(rawComment),
                date: rawDate,
                name: String(rawName)
            };
        });

    return convertDonations(
        donations,
        "DonatePay"
    );
}

async function getDonationAlertsTotal() {
    const donations = (
        await donationAlertsTransactions()
    )
        .filter(donation =>
            donation.is_shown !== 0 &&
            donation.is_shown !== false
        )
        .map(donation => ({
            id: makeId("da", donation.id, [
                donation.created_at,
                donation.amount,
                donation.currency,
                pickName(donation)
            ]),
            amount: donation.amount,
            currency: donation.currency,
            message: donation.message || "",
            date: donation.created_at,
            name: pickDonationAlertsName(donation)
        }));

    return convertDonations(
        donations,
        "DonationAlerts"
    );
}

async function getStreamlabsTotal() {
    if (
        streamlabsDonations.length === 0 &&
        state.sourcesConfig.streamlabs
    ) {
        try {
            streamlabsDonations = loadStreamlabsDonations();
        } catch (error) {
            console.error(error.message);
        }
    }

    return convertDonations(
        streamlabsDonations,
        "Streamlabs"
    );
}

/* CUSTOM SOURCES (added from the admin page) */
let customSources = [];
let customSourcesBroken = false;

function loadCustomSources() {
    try {
        if (!fs.existsSync(CUSTOM_SOURCES_FILE)) {
            return [];
        }

        const saved = JSON.parse(
            fs.readFileSync(CUSTOM_SOURCES_FILE, "utf8")
        );

        if (!Array.isArray(saved)) {
            throw new Error("The file is not a list");
        }

        return saved.filter(item =>
            item &&
            typeof item.key === "string" &&
            typeof item.name === "string" &&
            typeof item.url === "string"
        );
    } catch (error) {
        customSourcesBroken = true;
        console.error(
            "Could not read custom-sources.json:",
            error.message
        );
        return [];
    }
}

function saveCustomSources() {
    const temporaryFile = CUSTOM_SOURCES_FILE + ".tmp";

    fs.writeFileSync(
        temporaryFile,
        JSON.stringify(customSources, null, 2),
        "utf8"
    );

    fs.renameSync(temporaryFile, CUSTOM_SOURCES_FILE);
}

customSources = loadCustomSources();

const CUSTOM_FIELDS = {
    id: ["id", "donation_id", "donationid", "uuid", "_id", "transaction_id", "event_id"],
    amount: ["amount", "amount_value", "donation_amount", "sum", "value", "total"],
    currency: ["currency", "currency_code", "currencycode", "cur"],
    date: ["created_at", "createdat", "date", "created", "timestamp", "time", "datetime", "created_on"],
    name: ["name", "username", "user_name", "donor", "donor_name", "donorname", "display_name", "nickname", "from"],
    message: ["message", "comment", "msg", "text", "note"]
};

function findCustomList(data, depth = 0) {
    if (Array.isArray(data)) {
        return data;
    }

    if (!data || typeof data !== "object" || depth > 2) {
        return null;
    }

    for (const value of Object.values(data)) {
        if (Array.isArray(value)) {
            return value;
        }
    }

    for (const value of Object.values(data)) {
        const found = findCustomList(value, depth + 1);

        if (found) {
            return found;
        }
    }

    return null;
}

function customField(item, names) {
    const keys = Object.keys(item);

    for (const wanted of names) {
        const key = keys.find(k => k.toLowerCase() === wanted);

        if (key === undefined) {
            continue;
        }

        const value = item[key];

        if (
            value !== null &&
            value !== "" &&
            typeof value !== "object"
        ) {
            return value;
        }
    }

    return undefined;
}

function customDate(value) {
    if (value === undefined) {
        return null;
    }

    let time;

    if (typeof value === "number" || /^\d+$/.test(String(value))) {
        const number = Number(value);
        time = number < 1e11 ? number * 1000 : number;
    } else {
        time = Date.parse(String(value));
    }

    if (!Number.isFinite(time)) {
        return null;
    }

    try {
        return new Date(time).toISOString();
    } catch (error) {
        return null;
    }
}

function customDonations(list, source) {
    const result = [];

    for (const item of list) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            continue;
        }

        const amount = Number(customField(item, CUSTOM_FIELDS.amount));

        const currency = String(
            customField(item, CUSTOM_FIELDS.currency) ??
            source.currency ??
            ""
        ).toUpperCase();

        const date = customDate(customField(item, CUSTOM_FIELDS.date));

        if (
            !Number.isFinite(amount) ||
            amount <= 0 ||
            !currency ||
            !date
        ) {
            continue;
        }

        const name = customField(item, CUSTOM_FIELDS.name);
        const message = customField(item, CUSTOM_FIELDS.message);

        result.push({
            id: makeId(
                source.key,
                customField(item, CUSTOM_FIELDS.id),
                [date, amount, currency, name]
            ),
            amount,
            currency,
            date,
            name: name === undefined ? "Anonymous" : String(name),
            message: message === undefined ? "" : String(message)
        });
    }

    return result;
}

async function fetchCustomSourceList(source) {
    const hasPlaceholder = source.url.includes("{token}");

    const url = hasPlaceholder
        ? source.url.split("{token}").join(
            encodeURIComponent(source.token || "")
        )
        : source.url;

    const headers = { Accept: "application/json" };

    if (source.token && !hasPlaceholder) {
        headers.Authorization = "Bearer " + source.token;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    let data;

    try {
        const response = await fetch(url, {
            headers,
            cache: "no-store",
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`${source.name} HTTP ${response.status}`);
        }

        data = await response.json();
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error(`${source.name} did not answer within 15 seconds`);
        }

        if (error.message.startsWith(source.name)) {
            throw error;
        }

        throw new Error(`${source.name} could not be reached or did not send JSON data`);
    } finally {
        clearTimeout(timer);
    }

    const list = findCustomList(data);

    if (!list) {
        throw new Error(`${source.name}: no list of donations found in the data`);
    }

    return list;
}

async function getCustomSourceTotal(source) {
    const list = await fetchCustomSourceList(source);

    return convertDonations(
        customDonations(list, source),
        source.name
    );
}

async function testCustomSource(source) {
    const list = await fetchCustomSourceList(source);

    if (list.length === 0) {
        return { count: 0 };
    }

    const first = list.find(item =>
        item && typeof item === "object" && !Array.isArray(item)
    );

    if (!first) {
        throw new Error("The data from this link does not look like a list of donations.");
    }

    const donations = customDonations(list, source);

    if (donations.length === 0) {
        const fields = Object.keys(first).slice(0, 15).join(", ");

        throw new Error(
            `Found ${list.length} entries, but could not read an amount, currency and date from them. ` +
            `The first entry has these fields: ${fields}. ` +
            `If there is no currency field, type a currency in the form.`
        );
    }

    await convertDonations(donations.slice(0, 3), source.name);

    return { count: donations.length };
}

let lastGood = {};

async function collectOpen(options = {}) {
    const allGoals = options.allGoals === true;
    const definitions = [
        {
            key: "donatePay",
            label: "DonatePay",
            enabled: state.sourcesConfig.donatePay !== false,
            run: getDonatePayTotal
        },
        {
            key: "donationAlerts",
            label: "DonationAlerts",
            enabled: state.sourcesConfig.donationAlerts,
            run: getDonationAlertsTotal
        },
        {
            key: "streamlabs",
            label: "Streamlabs",
            enabled: state.sourcesConfig.streamlabs,
            run: getStreamlabsTotal
        },
        ...customSources.map(source => ({
            key: source.key,
            label: source.name,
            enabled: state.sourcesConfig[source.key] === true,
            run: () => getCustomSourceTotal(source)
        }))
    ];

    const active = definitions.filter(
        source => source.enabled
    );

    const settled = await Promise.allSettled(
        active.map(source => source.run())
    );

    const sources = {};
    const failed = [];

    let items = [];

    for (const source of definitions) {
        if (!source.enabled) {
            sources[source.key] = {
                enabled: false
            };
        }
    }

    active.forEach((source, index) => {
        const result = settled[index];

        if (result.status === "fulfilled") {
            lastGood[source.key] = result.value;

            items.push(...result.value.items);

            sources[source.key] = {
                enabled: true,
                ok: true,
                totalCAD: Number(
                    result.value.total.toFixed(2)
                ),
                donationCount: result.value.count
            };
        } else {
            console.error(
                `${source.label} error:`,
                result.reason
            );

            failed.push(source.label);

            const old = lastGood[source.key];

            if (old) {
                items.push(...old.items);
            }

            sources[source.key] = {
                enabled: true,
                ok: false,
                usingLastKnownData: Boolean(old),
                error: String(
                    result.reason?.message || result.reason
                )
            };
        }
    });

    /*
     * Restore manually retained donations when their original
     * source no longer returns them.
     *
     * Live source records take priority to avoid duplicates.
     */
    const liveIds = new Set(items.map(item => item.id));

    for (const saved of Object.values(state.manualDonations || {})) {
        if (!saved || !saved.id || liveIds.has(saved.id)) {
            continue;
        }

        const timestamp = Date.parse(saved.time || saved.date || "");

        items.push({
            id: saved.id,
            source: saved.source || "Manual",
            name: saved.name || "Anonymous",
            amount: Number(saved.amount || 0),
            currency: saved.currency || "CAD",
            message: saved.message || "",
            cad: Number(saved.amountCAD || 0),
            time: saved.time || saved.date || "",
            timestamp: Number.isFinite(timestamp) ? timestamp : 0,
            included: saved.included !== false
        });

        liveIds.add(saved.id);
    }

    if (sources.streamlabs) {
        sources.streamlabs.connected = streamlabsConnected;
    }

    items.sort(
        (a, b) => a.timestamp - b.timestamp
    );

    /*
     * Only show donations belonging to the current goal.
     * Unassigned donations automatically belong to Current.
     */
    const currentGoalId = state.current.id;

    if (!allGoals) {
        items = items.filter(item => {
            const assignedGoalId =
                state.goalDonationIds?.[item.id];

            return (
                !assignedGoalId ||
                assignedGoalId === currentGoalId
            );
        });
    }

    /*
     * Every donation remains available to the admin.
     * Only included donations contribute to the total.
     */
    const excludedIds = excludedIdSet();

    for (const item of items) {
        item.included = !excludedIds.has(item.id);
    }

    const targetCurr = (state.targetCurrency || "CAD").toLowerCase();

  async function convertToTarget(amount, fromCurr, dateStr) {
      if (!fromCurr) fromCurr = "CAD";
      if (fromCurr.toLowerCase() === targetCurr) return amount;
      try {
          const rate = await getHistoricalRate(fromCurr, targetCurr, String(dateStr || "").slice(0, 10));
          return amount * rate;
      } catch (e) {
          try {
              const rateToCAD = await getHistoricalRate(fromCurr, "cad", String(dateStr || "").slice(0, 10));
              const cadVal = amount * rateToCAD;
              if (targetCurr === "cad") return cadVal;
              const targetToCAD = await getHistoricalRate(targetCurr, "cad", String(dateStr || "").slice(0, 10));
              return cadVal / targetToCAD;
          } catch (err) {
              return amount;
          }
      }
  }

  let total = 0;
  for (const item of items) {
      const targetAmount = await convertToTarget(item.amount, item.currency, item.time);
      item.targetAmount = Number(targetAmount.toFixed(2));
      item.displayCurrency = state.targetCurrency || "CAD";
      if (item.included) {
          total += item.targetAmount;
      }
  }

  const includedItems = items.filter(item => item.included);

  return {
      items,
      includedItems,
      total,
      failed,
      okCount: active.length - failed.length,
      sources
  };

  return {
      items,
      includedItems,
      total,
      failed,
      okCount: active.length - failed.length,
      sources
  };
}

function publicItem(item) {
    const activeCurr = state.targetCurrency || "CAD";
    return {
        id: item.id,
        name: item.name,
        amount: item.amount,
        displayAmount: item.targetAmount !== undefined ? item.targetAmount : item.amount,
        currency: item.currency, // <--- Fix: keeps the donor's original currency
        message: item.message || "",
        amountCAD: Number((item.targetAmount !== undefined ? item.targetAmount : item.amount).toFixed(2)),
        source: item.source,
        time: item.time,
        date: item.time,
        included: item.included !== false
    };
}

function recalculateClosedGoal(goal) {
    goal.total = Number(
        (goal.donations || []).reduce((sum, donation) => {
            if (donation.included === false) {
                return sum;
            }

            return sum + Number(donation.amountCAD || 0);
        }, 0).toFixed(2)
    );

    goal.reachedGoal = goal.total >= goal.amount;

    return goal;
}

function cleanName(value) {
    return String(value ?? "")
        .trim()
        .slice(0, 80);
}

function cleanAmount(value) {
    const amount = Number(value);

    return Number.isFinite(amount) && amount > 0
        ? Number(amount.toFixed(2))
        : null;
}

/* OVERLAY LOOK (set from the admin page) */
const STYLE_FILE = path.join(__dirname, "overlay-style.json");
const STYLE_FONTS = ["Press Start 2P", "Roboto", "Open Sans", "Montserrat"];

const STYLE_SCHEMA = {
    goal: {
        fillColor:    { type: "color",  def: "#880808" },
        barColor:     { type: "color",  def: "#110101" },
        textColor:    { type: "color",  def: "#FFFFFF" },
        outlineColor: { type: "color",  def: "#000000" },
        font:         { type: "font",   def: "Press Start 2P" },
        titleSize:    { type: "number", def: 20,  min: 8,   max: 60 },
        amountSize:   { type: "number", def: 21,  min: 8,   max: 60 },
        barHeight:    { type: "number", def: 35,  min: 10,  max: 120 },
        width:        { type: "number", def: 700, min: 200, max: 1800 }
    }
};
STYLE_SCHEMA.goal.rainbow = { type: "boolean", def: true };
STYLE_SCHEMA.goal.enabled = { type: "boolean", def: true };
STYLE_SCHEMA.names = {
    enabled: { type: "boolean", def: true },
    textColor: { type: "color", def: "" }
};

function cleanStyleValue(rule, value) {
    if (rule.type === "boolean") {
        return value === false || value === "false"
            ? false
            : value === true || value === "true"
                ? true
                : rule.def;
    }
    if (value === undefined || value === null) {
        return rule.def;
    }

    if (rule.type === "color") {
        const text = String(value).trim();
        if (text === "") {
            return "";
        }
        const normalized = text.startsWith("#") ? text : "#" + text;
        return /^#[0-9a-fA-F]{6}$/.test(normalized)
            ? normalized.toUpperCase()
            : rule.def;
    }

    if (value === "") {
        return rule.def;
    }

    if (rule.type === "font") {
        return STYLE_FONTS.includes(value) ? value : rule.def;
    }

    const number = Number(value);

    if (!Number.isFinite(number)) {
        return rule.def;
    }

    return Math.round(Math.min(rule.max, Math.max(rule.min, number)));
}

function cleanStyle(input) {
    const result = {};

    for (const [group, rules] of Object.entries(STYLE_SCHEMA)) {
        result[group] = {};

        for (const [key, rule] of Object.entries(rules)) {
            result[group][key] = cleanStyleValue(
                rule,
                input?.[group]?.[key]
            );
        }
    }

    return result;
}

function loadOverlayStyle() {
    try {
        if (!fs.existsSync(STYLE_FILE)) {
            return cleanStyle({});
        }

        return cleanStyle(
            JSON.parse(fs.readFileSync(STYLE_FILE, "utf8"))
        );
    } catch (error) {
        console.error(
            "Could not read overlay-style.json:",
            error.message
        );

        return cleanStyle({});
    }
}

let overlayStyle = loadOverlayStyle();

/* Public: the overlays read this (CORS open so the names overlay can too) */
app.get("/api/style", (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.json(overlayStyle);
});

/* Admin: save the look */
app.post("/api/admin/set-style", (req, res) => {
    const next = req.body?.reset === true
        ? cleanStyle({})
        : cleanStyle(
            Object.fromEntries(
                Object.keys(STYLE_SCHEMA).map(group => [
                    group,
                    {
                        ...overlayStyle[group],
                        ...(req.body?.style?.[group] || {})
                    }
                ])
            )
        );

    const temporaryFile = STYLE_FILE + ".tmp";

    try {
        fs.writeFileSync(
            temporaryFile,
            JSON.stringify(next, null, 2),
            "utf8"
        );

        fs.renameSync(temporaryFile, STYLE_FILE);
    } catch (error) {
        console.error("Could not save overlay look:", error);

        return res.status(500).json({
            error: "Could not save: " + error.message
        });
    }

    overlayStyle = next;

    res.json({ ok: true, style: overlayStyle });
});

/* PUBLIC DONATION GOAL */
app.get("/api/goal", async (req, res) => {
    try {
        const open = await collectOpen();

        if (open.okCount === 0) {
            throw new Error(
                "All donation sources are unavailable"
            );
        }

        res.json({
            status: "success",
            name: state.current.name,
            goal: state.current.amount,
            goalNumber: state.closed.length + 1,
            totalCAD: Number(open.total.toFixed(2)),
            donationCount: open.includedItems.length,
            sources: open.sources,
            targetCurrency: state.targetCurrency || "CAD"
        });
    } catch (error) {
        console.error(
            "Combined donation goal error:",
            error
        );

        res.status(500).json({
            status: "error",
            error: error.message
        });
    }
});

/* ADMIN STATE */
app.get("/api/admin/state", async (req, res) => {
    try {
        const all = await collectOpen({ allGoals: true });

        const currentItems = all.items.filter(item => {
            const assignedGoalId =
                state.goalDonationIds?.[item.id];

            return (
                !assignedGoalId ||
                assignedGoalId === state.current.id
            );
        });

        const currentIncludedItems = currentItems.filter(
            item => item.included
        );

        const currentTotal = currentIncludedItems.reduce(
            (sum, item) => sum + (item.targetAmount !== undefined ? item.targetAmount : item.cad),
            0
        );

        const queueDonations = {};

        for (const goal of state.queue) {
            queueDonations[goal.id] = all.items
                .filter(item =>
                    state.goalDonationIds?.[item.id] === goal.id
                )
                .map(publicItem);
        }

        res.json({
            targetCurrency: state.targetCurrency || "CAD",
            current: state.current,
            queue: state.queue,
            queueDonations,
            goalNumber: state.closed.length + 1,

            open: {
                total: Number(currentTotal.toFixed(2)),
                reached:
                    currentTotal + 0.005 >= state.current.amount,
                failed: all.failed,
                sources: all.sources,

                donations: currentItems.map(publicItem),

                includedCount: currentIncludedItems.length,
                excludedCount:
                    currentItems.length - currentIncludedItems.length
            },

            closed: state.closed,

            customSources: customSources.map(item => ({
                key: item.key,
                name: item.name
            }))
        });
    } catch (error) {
        console.error("Admin state error:", error);

        res.status(500).json({
            error: error.message
        });
    }
});


/* INCLUDE OR EXCLUDE AN INDIVIDUAL DONATION */
app.post("/api/admin/toggle-donation", (req, res) => {
    const id = String(req.body?.id ?? "");
    const included = req.body?.included;

    if (!id) {
        return res.status(400).json({
            error: "Missing donation ID."
        });
    }

    if (typeof included !== "boolean") {
        return res.status(400).json({
            error: "Invalid inclusion setting."
        });
    }

    if (closedIdSet().has(id)) {
        return res.status(409).json({
            error: "This donation belongs to a closed goal."
        });
    }

    const previous = [...state.excludedDonationIds];

    if (included) {
        state.excludedDonationIds =
            state.excludedDonationIds.filter(
                existing => existing !== id
            );
    } else {
        if (!state.excludedDonationIds.includes(id)) {
            state.excludedDonationIds.push(id);
        }
    }

    try {
        saveState();
    } catch (error) {
        state.excludedDonationIds = previous;

        console.error(
            "Could not save donation inclusion:",
            error
        );

        return res.status(500).json({
            error:
                "Could not save donation setting: " +
                error.message
        });
    }

    lastGood = {};

    console.log(
        `Donation ${id}: ${included ? "INCLUDED" : "EXCLUDED"}`
    );

    res.json({
        ok: true,
        id,
        included,
        excludedDonationIds: state.excludedDonationIds
    });
});

/* MOVE A DONATION TO ANOTHER GOAL */
app.post("/api/admin/move-donation", async (req, res) => {
    try {
        const id = String(req.body?.id ?? "");
        const targetGoalId = String(req.body?.targetGoalId ?? "");

        if (!id || !targetGoalId) {
            return res.status(400).json({
                error: "Missing donation ID or destination goal."
            });
        }

        const targetIsCurrent = state.current.id === targetGoalId;

        const targetIsQueued = state.queue.some(
            goal => goal.id === targetGoalId
        );

        const targetClosed = state.closed.find(
            goal => goal.id === targetGoalId
        );

        if (
            !targetIsCurrent &&
            !targetIsQueued &&
            !targetClosed
        ) {
            return res.status(404).json({
                error: "That destination goal no longer exists."
            });
        }

        const sourceClosed = state.closed.find(
            goal => (goal.donations || []).some(
                donation => donation.id === id
            )
        );

        const sourceGoalId = sourceClosed
            ? sourceClosed.id
            : (state.goalDonationIds?.[id] || state.current.id);

        if (sourceGoalId === targetGoalId) {
            return res.status(409).json({
                error: "That donation already belongs to this goal."
            });
        }

        /*
         * Find the donation in live/retained records first.
         * If it is archived, its saved archive record is the fallback.
         */
        const open = await collectOpen({ allGoals: true });

        const liveItem = open.items.find(
            item => item.id === id
        );

        const archivedItem = sourceClosed
            ? sourceClosed.donations.find(
                donation => donation.id === id
            )
            : null;

        if (!liveItem && !archivedItem) {
            return res.status(404).json({
                error: "The donation could not be found."
            });
        }

        const donationRecord = liveItem
            ? publicItem(liveItem)
            : { ...archivedItem };

        const previous = state;

        const nextClosed = state.closed.map(goal => ({
            ...goal,
            donations: (goal.donations || []).filter(
                donation => donation.id !== id
            )
        }));

        const nextManualDonations = {
            ...(state.manualDonations || {})
        };

        const nextGoalDonationIds = {
            ...(state.goalDonationIds || {})
        };

        /*
         * Moving into an archived goal:
         * store one archive snapshot and recalculate its total.
         */
        if (targetClosed) {
            delete nextManualDonations[id];

            const destination = nextClosed.find(
                goal => goal.id === targetGoalId
            );

            destination.donations.push({
                ...donationRecord
            });

            recalculateClosedGoal(destination);
        } else {
            /*
             * Moving out of an archive:
             * retain a copy so the donation remains available
             * even if its original source stops returning it.
             */
            if (sourceClosed) {
                nextManualDonations[id] = {
                    ...donationRecord
                };
            }
        }

        /*
         * Recalculate the previous archive too, if applicable.
         */
        if (sourceClosed) {
            const previousArchive = nextClosed.find(
                goal => goal.id === sourceClosed.id
            );

            if (previousArchive) {
                recalculateClosedGoal(previousArchive);
            }
        }

        nextGoalDonationIds[id] = targetGoalId;

        state = {
            ...state,
            closed: nextClosed,
            manualDonations: nextManualDonations,
            goalDonationIds: nextGoalDonationIds
        };

        try {
            saveState();
        } catch (error) {
            state = previous;
            throw error;
        }

        lastGood = {};

        console.log(
            `Moved donation ${id} from ${sourceGoalId} to ${targetGoalId}.`
        );

        res.json({
            ok: true,
            id,
            targetGoalId
        });

    } catch (error) {
        console.error("Move donation error:", error);

        res.status(500).json({
            error: "Could not move donation: " + error.message
        });
    }
});

/* TOGGLE SOURCES */
app.post("/api/admin/toggle-source", (req, res) => {
    const { source } = req.body;

    if (
        source !== "donatePay" &&
        source !== "donationAlerts" &&
        source !== "streamlabs" &&
        !customSources.some(item => item.key === source)
    ) {
        return res.status(400).json({
            error: "Invalid source"
        });
    }

    const previousValue = source === "donatePay"
        ? state.sourcesConfig.donatePay !== false
        : state.sourcesConfig[source];

    state.sourcesConfig[source] = !previousValue;

    try {
        saveState();
    } catch (error) {
        state.sourcesConfig[source] = previousValue;

        return res.status(500).json({
            error: "Could not save state: " + error.message
        });
    }

    if (source === "streamlabs") {
        if (state.sourcesConfig.streamlabs) {
            try {
                streamlabsDonations = loadStreamlabsDonations();
            } catch (error) {
                console.error(error.message);
            }

            startStreamlabs();
        } else if (streamlabsSocket) {
            streamlabsSocket.disconnect();
            streamlabsSocket = null;
            streamlabsConnected = false;
        }
    }

    lastGood = {};

    res.json({
        ok: true,
        sourcesConfig: state.sourcesConfig
    });
});

/* ADD A DONATION SOURCE */
app.post("/api/admin/add-source", async (req, res) => {
    if (customSourcesBroken) {
        return res.status(500).json({
            error: "custom-sources.json could not be read. Fix or delete that file, then restart the server."
        });
    }

    const name = String(req.body?.name ?? "").trim();
    const url = String(req.body?.url ?? "").trim();
    const token = String(req.body?.token ?? "").trim();
    const currency = String(req.body?.currency ?? "").trim().toUpperCase();

    if (!name || name.length > 30) {
        return res.status(400).json({
            error: "Enter a source name (up to 30 characters)."
        });
    }

    const taken = [
        "donatepay",
        "donationalerts",
        "streamlabs",
        "manual",
        ...customSources.map(item => item.name.toLowerCase())
    ];

    if (taken.includes(name.toLowerCase())) {
        return res.status(400).json({
            error: "A source with that name already exists."
        });
    }

    if (customSources.length >= 10) {
        return res.status(400).json({
            error: "The limit is 10 added sources."
        });
    }

    if (currency && !/^[A-Z]{3}$/.test(currency)) {
        return res.status(400).json({
            error: "Currency must be a 3-letter code like CAD or USD."
        });
    }

    let parsed;

    try {
        parsed = new URL(url.split("{token}").join("token"));
    } catch (error) {
        return res.status(400).json({
            error: "The API link is not a valid web address."
        });
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return res.status(400).json({
            error: "The API link must start with https://"
        });
    }

    if (url.includes("{token}") && !token) {
        return res.status(400).json({
            error: "The link contains {token}, so the token box cannot be empty."
        });
    }

    const source = {
        key: "custom_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name,
        url,
        token,
        currency
    };

    let test;

    try {
        test = await testCustomSource(source);
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    customSources.push(source);

    try {
        saveCustomSources();
    } catch (error) {
        customSources.pop();

        return res.status(500).json({
            error: "Could not save the source: " + error.message
        });
    }

    state.sourcesConfig[source.key] = true;

    try {
        saveState();
    } catch (error) {
        delete state.sourcesConfig[source.key];
        customSources.pop();

        try {
            saveCustomSources();
        } catch (innerError) {
            console.error("Could not undo custom source save:", innerError.message);
        }

        return res.status(500).json({
            error: "Could not save state: " + error.message
        });
    }

    lastGood = {};

    res.json({
        ok: true,
        key: source.key,
        name: source.name,
        count: test.count
    });
});

/* REMOVE A DONATION SOURCE */
app.post("/api/admin/remove-source", (req, res) => {
    if (customSourcesBroken) {
        return res.status(500).json({
            error: "custom-sources.json could not be read. Fix or delete that file, then restart the server."
        });
    }

    const key = String(req.body?.key ?? "");
    const index = customSources.findIndex(item => item.key === key);

    if (index < 0) {
        return res.status(400).json({
            error: "That source no longer exists."
        });
    }

    const [removed] = customSources.splice(index, 1);

    try {
        saveCustomSources();
    } catch (error) {
        customSources.splice(index, 0, removed);

        return res.status(500).json({
            error: "Could not save: " + error.message
        });
    }

    const previous = state.sourcesConfig[key];
    delete state.sourcesConfig[key];

    try {
        saveState();
    } catch (error) {
        state.sourcesConfig[key] = previous;
        customSources.splice(index, 0, removed);

        try {
            saveCustomSources();
        } catch (innerError) {
            console.error("Could not undo custom source removal:", innerError.message);
        }

        return res.status(500).json({
            error: "Could not save state: " + error.message
        });
    }

    lastGood = {};

    res.json({
        ok: true,
        name: removed.name
    });
});

/* SET TARGET CURRENCY */
app.post("/api/admin/set-target-currency", (req, res) => {
    const currency = String(req.body?.currency ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
        return res.status(400).json({
            error: "Invalid currency code."
        });
    }

    const previous = state.targetCurrency;
    state.targetCurrency = currency;

    try {
        saveState();
    } catch (error) {
        state.targetCurrency = previous;
        return res.status(500).json({
            error: "Could not save state: " + error.message
        });
    }

    lastGood = {};

    res.json({
        ok: true,
        targetCurrency: state.targetCurrency
    });
});

/* EDIT CURRENT GOAL */
app.post("/api/admin/set-goal", (req, res) => {
    const name = cleanName(req.body?.name);
    const amount = cleanAmount(req.body?.amount);

    if (!name) {
        return res.status(400).json({
            error: "The goal needs a name."
        });
    }

    if (amount === null) {
        return res.status(400).json({
            error: "The goal amount must be above 0."
        });
    }

    const previous = state.current;

    state.current = {
        ...state.current,
        name,
        amount
    };

    try {
        saveState();
    } catch (error) {
        state.current = previous;

        console.error(
            "Could not save goal state:",
            error
        );

        return res.status(500).json({
            error: "Could not save: " + error.message
        });
    }

    res.json({ ok: true });
});

/* CLOSE CURRENT GOAL AND START NEW GOAL */
app.post("/api/admin/new-goal", async (req, res) => {
    try {
        const name = cleanName(req.body?.name);
        const amount = cleanAmount(req.body?.amount);

        const ids = Array.isArray(req.body?.ids)
            ? req.body.ids.map(String)
            : [];

        const queueId = req.body?.queueId
            ? String(req.body.queueId)
            : null;

        if (!name) {
            return res.status(400).json({
                error: "The new goal needs a name."
            });
        }

        if (amount === null) {
            return res.status(400).json({
                error: "The new goal amount must be above 0."
            });
        }

        if (ids.length === 0) {
            return res.status(400).json({
                error:
                    "There are no included donations to lock into the current goal."
            });
        }

        if (
            queueId &&
            !state.queue.some(item => item.id === queueId)
        ) {
            return res.status(409).json({
                error: "That queued goal no longer exists."
            });
        }

        const open = await collectOpen();

        if (open.failed.length > 0) {
            return res.status(409).json({
                error:
                    `${open.failed.join(", ")} could not be reached, so the list may be incomplete. Try again in a moment.`
            });
        }

        /*
         * Only included donations can be locked into a goal.
         */
        const chosen = open.includedItems.filter(
            item => ids.includes(item.id)
        );

        if (
            chosen.length !== ids.length ||
            new Set(ids).size !== ids.length
        ) {
            return res.status(409).json({
                error:
                    "The donation list changed. Refresh the page and try again."
            });
        }

        const goalTotal = chosen.reduce(
            (sum, item) => sum + item.cad,
            0
        );

        if (
            goalTotal + 0.005 <
            state.current.amount
        ) {
            return res.status(409).json({
                error:
                    "The current goal has not been reached yet. New goals wait in line until it is."
            });
        }

        const closedGoal = {
            id: state.current.id,
            number: state.closed.length + 1,
            name: state.current.name,
            amount: state.current.amount,
            reachedGoal:
                goalTotal >= state.current.amount,
            total: Number(goalTotal.toFixed(2)),
            closedAt: new Date().toISOString(),
            donations: chosen.map(publicItem)
        };

        const previous = state;

        /*
         * Excluded donations are NOT included in closedGoal.
         * Their exclusion settings are retained.
         */
        const closedIds = new Set(
            chosen.map(item => item.id)
        );

        const newCurrentId = queueId
            ? state.queue.find(item => item.id === queueId).id
            : newQueueId();

        /*
         * Donations that were in the old goal's list but were NOT
         * locked into it now belong to the new goal.
         */
        const goalDonationIds = {
            ...(state.goalDonationIds || {})
        };

        for (const id of closedIds) {
            goalDonationIds[id] = closedGoal.id;
        }

        for (const item of open.items) {
            if (!closedIds.has(item.id)) {
                goalDonationIds[item.id] = newCurrentId;
            }
        }

        state = {
            ...state,

            current: {
                id: newCurrentId,
                name,
                amount
            },

            closed: [
                ...state.closed,
                closedGoal
            ],

            queue: state.queue.filter(
                item => item.id !== queueId
            ),

            excludedDonationIds:
                state.excludedDonationIds.filter(
                    id => !closedIds.has(id)
                ),

            goalDonationIds
        };

        try {
            saveState();
        } catch (error) {
            state = previous;

            console.error(
                "Could not save goal state:",
                error
            );

            return res.status(500).json({
                error: "Could not save: " + error.message
            });
        }

        lastGood = {};

        console.log(
            `Closed DonGoal${closedGoal.number} "${closedGoal.name}" with ${chosen.length} donation(s).`
        );

        res.json({
            ok: true,
            closedGoalNumber: closedGoal.number
        });

    } catch (error) {
        console.error("New goal error:", error);

        res.status(500).json({
            error: error.message
        });
    }
});


/* ADD GOAL TO QUEUE */
app.post("/api/admin/queue-add", (req, res) => {
    const name = cleanName(req.body?.name);
    const amount = cleanAmount(req.body?.amount);

    if (!name) {
        return res.status(400).json({
            error: "The new goal needs a name."
        });
    }

    if (amount === null) {
        return res.status(400).json({
            error: "The goal amount must be above 0."
        });
    }

    const previous = state;

    state = {
        ...state,
        queue: [
            ...state.queue,
            { id: newQueueId(), name, amount }
        ]
    };

    try {
        saveState();
    } catch (error) {
        state = previous;

        console.error("Could not save queued goal:", error);

        return res.status(500).json({
            error: "Could not save: " + error.message
        });
    }

    console.log(`Added "${name}" (${amount} CAD) to the goal queue.`);

    res.json({ ok: true });
});

/* EDIT QUEUED GOAL */
app.post("/api/admin/queue-edit", (req, res) => {
    const id = String(req.body?.id ?? "");
    const name = cleanName(req.body?.name);
    const amount = cleanAmount(req.body?.amount);

    if (!id) {
        return res.status(400).json({
            error: "Missing queued goal ID."
        });
    }

    if (!name) {
        return res.status(400).json({
            error: "The goal needs a name."
        });
    }

    if (amount === null) {
        return res.status(400).json({
            error: "The goal amount must be above 0."
        });
    }

    const index = state.queue.findIndex(
        goal => goal.id === id
    );

    if (index === -1) {
        return res.status(404).json({
            error: "That queued goal no longer exists."
        });
    }

    const previous = state;

    state = {
        ...state,
        queue: state.queue.map((goal, i) =>
            i === index
                ? { ...goal, name, amount }
                : goal
        )
    };

    try {
        saveState();
    } catch (error) {
        state = previous;

        console.error("Could not save edited queued goal:", error);

        return res.status(500).json({
            error: "Could not save: " + error.message
        });
    }

    console.log(`Updated queued goal "${name}" (${amount} CAD).`);

    res.json({ ok: true });
});

/* SWAP CURRENT GOAL WITH A QUEUED GOAL */
app.post("/api/admin/swap-goal", async (req, res) => {
    try {
        const id = String(req.body?.id ?? "");

        const index = state.queue.findIndex(
            item => item.id === id
        );

        if (index < 0) {
            return res.status(404).json({
                error: "That goal is no longer in the queue."
            });
        }

        const open = await collectOpen();

        if (open.failed.length > 0) {
            return res.status(409).json({
                error:
                    "Donation sources are unavailable. Wait until they are OK before swapping."
            });
        }

        const previous = state;
        const oldCurrent = state.current;
        const selected = state.queue[index];

        /*
         * Permanently assign all currently unassigned donations
         * to the goal that is leaving Current.
         */
        const goalDonationIds = {
            ...(state.goalDonationIds || {})
        };

        for (const donation of open.items) {
            if (!goalDonationIds[donation.id]) {
                goalDonationIds[donation.id] = oldCurrent.id;
            }
        }

        const newQueue = [...state.queue];

        /*
         * Put the old Current in the exact position previously
         * occupied by the selected queued goal.
         */
        newQueue[index] = oldCurrent;

        state = {
            ...state,
            current: selected,
            queue: newQueue,
            goalDonationIds
        };

        try {
            saveState();
        } catch (error) {
            state = previous;
            throw error;
        }

        lastGood = {};

        console.log(
            `Swapped Current to "${selected.name}". "${oldCurrent.name}" moved into the queue.`
        );

        res.json({
            ok: true,
            message: "Goal was moved to current."
        });

    } catch (error) {
        console.error("Goal swap error:", error);

        res.status(500).json({
            error: "Could not swap goals: " + error.message
        });
    }
});


/* REMOVE QUEUE ITEM */
app.post("/api/admin/queue-remove", (req, res) => {
    const id = String(req.body?.id ?? "");

    const queuedGoal = state.queue.find(
        item => item.id === id
    );

    if (!queuedGoal) {
        return res.status(404).json({
            error: "That goal is no longer in the line."
        });
    }

    const previous = state;

    /*
     * Reassign every donation belonging to the deleted
     * queued goal back to Current.
     */
    const goalDonationIds = {
        ...(state.goalDonationIds || {})
    };

    let reassignedCount = 0;

    for (const [donationId, assignedGoalId] of Object.entries(
        goalDonationIds
    )) {
        if (assignedGoalId === id) {
            goalDonationIds[donationId] = state.current.id;
            reassignedCount++;
        }
    }

    state = {
        ...state,

        queue: state.queue.filter(
            item => item.id !== id
        ),

        goalDonationIds
    };

    try {
        saveState();
    } catch (error) {
        state = previous;

        console.error(
            "Could not save removed goal:",
            error
        );

        return res.status(500).json({
            error: "Could not save state: " + error.message
        });
    }

    lastGood = {};

    console.log(
        `Removed queued goal "${queuedGoal.name}". ` +
        `${reassignedCount} donation(s) reassigned to Current.`
    );

    res.json({
        ok: true,
        reassignedCount,
        currentGoalId: state.current.id
    });
});


/* REOPEN LAST CLOSED GOAL */
app.post("/api/admin/reopen", async (req, res) => {
    try {
        if (state.closed.length === 0) {
            return res.status(400).json({
                error: "There is no closed goal to re-open."
            });
        }

        /*
         * Collect donations currently belonging to Current
         * before moving Current into the queue.
         *
         * If a source is unavailable, do not risk changing
         * donation assignments using an incomplete list.
         */
        const open = await collectOpen();

        if (
            open.failed.length > 0 ||
            open.okCount === 0
        ) {
            return res.status(409).json({
                error:
                    "Donation sources are unavailable. Wait until all sources are OK before reopening a goal."
            });
        }

        const previous = state;

        const goal = state.closed[state.closed.length - 1];
        const oldCurrent = state.current;

        /*
         * Preserve all existing donation assignments.
         *
         * Any unassigned donations currently visible belong
         * to the old Current goal. Assign them to that goal
         * before moving it into the queue.
         */
        const goalDonationIds = {
            ...(state.goalDonationIds || {})
        };

        for (const donation of open.items) {
            if (!goalDonationIds[donation.id]) {
                goalDonationIds[donation.id] = oldCurrent.id;
            }
        }

        /*
         * Restore the last closed goal as Current.
         * Move the previous Current goal to the front of the queue.
         *
         * The reopened goal's donations become visible again
         * because its closed record is removed from state.closed.
         */
        state = {
            ...state,

            current: {
                id: goal.id || newQueueId(),
                name: goal.name,
                amount: goal.amount
            },

            closed: state.closed.slice(0, -1),

            queue: [
                {
                    ...oldCurrent
                },
                ...state.queue
            ],

            goalDonationIds
        };

        try {
            saveState();
        } catch (error) {
            state = previous;

            console.error(
                "Could not save reopened goal:",
                error
            );

            return res.status(500).json({
                error: "Could not save: " + error.message
            });
        }

        lastGood = {};

        console.log(
            `Re-opened DonGoal${goal.number} "${goal.name}".`
        );

        res.json({
            ok: true,
            message: "Goal was reopened.",
            current: state.current
        });

    } catch (error) {
        console.error("Goal reopen error:", error);

        res.status(500).json({
            error: "Could not reopen goal: " + error.message
        });
    }
});

/* START SERVER */
const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(
        `DonateGoal running at http://localhost:${PORT}`
    );

    console.log(
        `Admin page: http://localhost:${PORT}/admin`
    );

    console.log(
        `DonationAlerts: ${state.sourcesConfig.donationAlerts ? "ENABLED" : "DISABLED"}`
    );

    console.log(
        `Streamlabs: ${state.sourcesConfig.streamlabs ? "ENABLED" : "DISABLED"}`
    );

    startStreamlabs();
});

server.on("error", error => {
    console.error(
        "Server could not start:",
        error.message
    );

    process.exit(1);
});
