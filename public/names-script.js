require("dotenv").config({
    path: require("path").join(__dirname, "..", ".env")
});

const express = require("express");
const io = require("socket.io-client");

const app = express();
const PORT = 3001;
const CACHE_TIME_MS = 30000;
const TWITCH_ANNOUNCE_URL = "http://127.0.0.1:3002/announce";
const GOAL_STATE_URL = "http://127.0.0.1:3000/api/admin/state";

const DONATIONALERTS_ENABLED =
    String(process.env.DONATIONALERTS_ENABLED || "false").toLowerCase() === "true";

const STREAMLABS_ENABLED =
    String(process.env.STREAMLABS_ENABLED || "false").toLowerCase() === "true";

app.get("/", (req, res) => {
    res.sendFile(require("path").join(__dirname, "names-index.html"));
});

app.use(express.static(__dirname));

let cachedTransactions = null;
let lastFetchTime = 0;
let pendingFetch = null;

const knownTransactionIds = new Set();
const announcingTransactionIds = new Set();
const initializedSources = new Set();

const knownStreamlabsIds = new Set();
let streamlabsSocket = null;

function getDonationAlertsName(donation) {
    const username = String(donation.username || "").trim();
    const name = String(donation.name || "").trim();
    const donorName = username || name;

    if (
        !donorName ||
        donorName.toLowerCase() === "anonymous" ||
        (!username && name.toLowerCase() === "donations")
    ) {
        return " ";
    }

    return donorName;
}

async function announceDonation(transaction) {
    try {
        const name =
            transaction.what ??
            transaction.vars?.name ??
            "Anonymous";

        const amount = Number(transaction.sum);

        const formattedAmount = Number.isFinite(amount)
            ? amount.toString()
            : String(transaction.sum || "");

        const currency =
            String(transaction.currency || "").toUpperCase();

        const displayName = String(name).trim();

        let message =
            `${displayName || "Anonymous"} +${currency} ${formattedAmount} with ${transaction.source || "DonatePay"}`;

        if (message.length > 500) {
            message = message.substring(0, 497) + "...";
        }

        console.log("Sending Twitch announcement:", message);

        const response = await fetch(TWITCH_ANNOUNCE_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                message,
                color: "purple"
            })
        });

        const text = await response.text();

        if (!response.ok) {
            throw new Error(
                `Twitch server returned HTTP ${response.status}: ${text}`
            );
        }

        console.log("Twitch announcement sent successfully.");
    } catch (error) {
        console.error(
            "Could not send Twitch announcement:",
            error.message
        );
    }
}

function isSuccessfulDonation(transaction) {
    const date = String(transaction.created_at || "");

    return (
        transaction.type === "donation" &&
        transaction.status === "success" &&
        date >= "2026-01-01" &&
        date < "2027-01-01"
    );
}

async function processNewDonations(transactions, source) {
    const successfulDonations =
        transactions.filter(isSuccessfulDonation);

    if (!initializedSources.has(source)) {
        for (const donation of successfulDonations) {
            knownTransactionIds.add(String(donation.id));
        }

        initializedSources.add(source);

        console.log(
            `Initialized ${source} with ${successfulDonations.length} existing successful donation(s).`
        );

        return;
    }

    for (const donation of successfulDonations) {
        const transactionId = String(donation.id);

        if (
            knownTransactionIds.has(transactionId) ||
            announcingTransactionIds.has(transactionId)
        ) {
            continue;
        }

        knownTransactionIds.add(transactionId);
        announcingTransactionIds.add(transactionId);

        console.log(
            "NEW SUCCESSFUL DONATION:",
            transactionId
        );

        try {
            await announceDonation(donation);
        } finally {
            announcingTransactionIds.delete(transactionId);
        }
    }
}

async function getDonatePayTransactions() {
    console.log("Requesting transactions from DonatePay...");

    const response = await fetch(
        `https://donatepay.eu/api/v1/transactions?access_token=${process.env.DONATEPAY_API_KEY}`
    );

    console.log("DonatePay HTTP status:", response.status);

    if (!response.ok) {
        throw new Error(
            `DonatePay API returned HTTP ${response.status}`
        );
    }

    const data = await response.json();

    if (!Array.isArray(data?.data)) {
        throw new Error(
            "DonatePay did not return a valid transaction list"
        );
    }

    return data.data.map(transaction => ({
        ...transaction,
        id: `dp_${transaction.id}`,
        source: "DonatePay"
    }));
}

async function getDonationAlertsTransactions() {
    const token = process.env.DONATIONALERTS_ACCESS_TOKEN;

    if (!token) {
        throw new Error(
            "Missing DONATIONALERTS_ACCESS_TOKEN"
        );
    }

    console.log(
        "Requesting transactions from DonationAlerts..."
    );

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
                `DonationAlerts API returned HTTP ${response.status}`
            );
        }

        const result = await response.json();

        if (!Array.isArray(result.data)) {
            throw new Error(
                "DonationAlerts did not return a valid donation list"
            );
        }

        donations.push(...result.data);

        const lastPage = Number(result.meta?.last_page);

        if (!Number.isInteger(lastPage) || lastPage < 1) {
            throw new Error(
                "DonationAlerts pagination metadata missing"
            );
        }

        if (page >= lastPage) {
            break;
        }

        page++;
    }

    return donations
        .filter(
            donation =>
                donation.is_shown !== 0 &&
                donation.is_shown !== false
        )
        .map(donation => {
            const name = getDonationAlertsName(donation);

            return {
                id: `da_${donation.id}`,
                source: "DonationAlerts",
                type: "donation",
                status: "success",
                what: name,
                vars: {
                    name,
                    comment: donation.message || ""
                },
                sum: donation.amount,
                currency: donation.currency,
                comment: donation.message || "",
                created_at: donation.created_at
            };
        });
}

async function fetchTransactions() {
    const results = await Promise.allSettled([
        getDonatePayTransactions(),
        DONATIONALERTS_ENABLED
            ? getDonationAlertsTransactions()
            : Promise.resolve([])
    ]);

    const [dpResult, daResult] = results;

    const previous = Array.isArray(cachedTransactions?.data)
        ? cachedTransactions.data
        : [];

    let dpTransactions = [];
    let daTransactions = [];

    if (dpResult.status === "fulfilled") {
        dpTransactions = dpResult.value;

        await processNewDonations(
            dpTransactions,
            "DonatePay"
        );
    } else {
        console.error(
            "DonatePay error:",
            dpResult.reason
        );

        dpTransactions = previous.filter(
            t => t.source === "DonatePay"
        );
    }

    if (DONATIONALERTS_ENABLED) {
        if (daResult.status === "fulfilled") {
            daTransactions = daResult.value;

            await processNewDonations(
                daTransactions,
                "DonationAlerts"
            );
        } else {
            console.error(
                "DonationAlerts error:",
                daResult.reason
            );

            daTransactions = previous.filter(
                t => t.source === "DonationAlerts"
            );
        }
    }

    if (
        dpResult.status !== "fulfilled" &&
        (
            !DONATIONALERTS_ENABLED ||
            daResult.status !== "fulfilled"
        ) &&
        cachedTransactions === null
    ) {
        throw new Error(
            "Both donation services are unavailable"
        );
    }

    const transactions = [
        ...dpTransactions,
        ...daTransactions
    ].sort(
        (a, b) =>
            new Date(b.created_at).getTime() -
            new Date(a.created_at).getTime()
    );

    cachedTransactions = {
        data: transactions,
        sources: {
            donatePay: {
                connected: dpResult.status === "fulfilled",
                donationCount:
                    dpTransactions.filter(isSuccessfulDonation).length
            },
            donationAlerts: {
                enabled: DONATIONALERTS_ENABLED,
                connected:
                    DONATIONALERTS_ENABLED &&
                    daResult.status === "fulfilled",
                donationCount:
                    daTransactions.filter(isSuccessfulDonation).length
            }
        }
    };

    lastFetchTime = Date.now();

    return cachedTransactions;
}

async function getTransactions() {
    if (
        cachedTransactions !== null &&
        Date.now() - lastFetchTime < CACHE_TIME_MS
    ) {
        return cachedTransactions;
    }

    if (pendingFetch) {
        return pendingFetch;
    }

    pendingFetch = fetchTransactions();

    try {
        return await pendingFetch;
    } finally {
        pendingFetch = null;
    }
}

function startStreamlabsSocket() {
    if (!STREAMLABS_ENABLED) {
        console.log("Streamlabs: DISABLED");
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
            query: {
                token
            },
            transports: ["websocket"],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 10000
        }
    );

    streamlabsSocket.on("connect", () => {
        console.log(
            "Streamlabs socket connected."
        );
    });

    streamlabsSocket.on("disconnect", reason => {
        console.log(
            "Streamlabs socket disconnected:",
            reason
        );
    });

    streamlabsSocket.on("connect_error", error => {
        console.error(
            "Streamlabs connection error:",
            error.message
        );
    });

    streamlabsSocket.on("error", error => {
        console.error(
            "Streamlabs socket error:",
            error?.message || error
        );
    });

    streamlabsSocket.on("event", async event => {
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
            const donationId =
                rawId === undefined || rawId === null
                    ? null
                    : `sl_${rawId}`;

            if (
                donationId &&
                knownStreamlabsIds.has(donationId)
            ) {
                continue;
            }

            if (donationId) {
                knownStreamlabsIds.add(donationId);
            }

            const transaction = {
                id: donationId,
                source: "Streamlabs",
                type: "donation",
                status: "success",
                what:
                    donation.from ??
                    donation.name ??
                    "Anonymous",
                sum: donation.amount,
                currency: donation.currency || "",
                comment: donation.message || "",
                created_at: new Date().toISOString()
            };

            console.log(
                "NEW STREAMLABS DONATION:",
                donationId || "No ID"
            );

            await announceDonation(transaction);
        }
    });
}

/*
 * GOAL ADMIN CONTROL
 *
 * Asks the goal server (port 3000) which sources are ON and which
 * donations are ticked Y/N, then filters the scrolling names to match.
 *
 * - Source OFF in the admin panel      -> its names are hidden.
 * - Donation unticked (N) in the panel -> that name is hidden.
 * - Donation ticked (Y)                -> that name is shown.
 * - Donation the goal server does not know about -> shown as before.
 * - Goal server unreachable            -> everything shown as before.
 */
const GOAL_SOURCE_NAMES = {
    donatePay: "DonatePay",
    donationAlerts: "DonationAlerts",
    streamlabs: "Streamlabs"
};

function stripIdPrefix(id) {
    return String(id ?? "").replace(/^((dp|da|sl)_)+/i, "");
}

function normalizeName(value) {
    return String(value ?? "").trim().toLowerCase();
}

let lastGoodGoalControl = null;

async function getGoalControl() {
    try {
        const response = await fetch(GOAL_STATE_URL, {
            headers: { "X-Admin": "1" },
            cache: "no-store",
            signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const state = await response.json();

        const sourceEnabled = {};

        for (const [key, label] of Object.entries(GOAL_SOURCE_NAMES)) {
            const s = state?.open?.sources?.[key];

            if (s) {
                sourceEnabled[label.toLowerCase()] = s.enabled !== false;
            }
        }

        const openDonations = Array.isArray(state?.open?.donations)
            ? state.open.donations
            : [];

        const closedDonations = Array.isArray(state?.closed)
            ? state.closed.flatMap(goal =>
                Array.isArray(goal.donations) ? goal.donations : []
            )
            : [];

        lastGoodGoalControl = {
            sourceEnabled,
            donations: [...openDonations, ...closedDonations]
        };

        return lastGoodGoalControl;
    } catch (error) {
        console.error(
            "Could not read goal admin state:",
            error.message,
            lastGoodGoalControl
                ? "(using last known admin settings)"
                : "(showing all names)"
        );

        return lastGoodGoalControl;
    }
}

function applyGoalControl(result, control) {
    if (!control || !result || !Array.isArray(result.data)) {
        return result;
    }

    const byId = new Map();
    const byDetails = new Map();

    for (const d of control.donations) {
        const source = normalizeName(d.source);
        const included = d.included !== false;

        if (d.id !== undefined && d.id !== null) {
            byId.set(`${source}|${stripIdPrefix(d.id)}`, included);
        }

        const detailsKey =
            `${source}|${normalizeName(d.name)}|${Number(d.amount)}|` +
            `${String(d.currency || "").toUpperCase()}`;

        if (!byDetails.has(detailsKey)) {
            byDetails.set(detailsKey, []);
        }

        byDetails.get(detailsKey).push(included);
    }

    const filtered = result.data.filter(transaction => {
        const source = normalizeName(transaction.source);

        if (control.sourceEnabled[source] === false) {
            return false;
        }

        const idKey = `${source}|${stripIdPrefix(transaction.id)}`;

        if (byId.has(idKey)) {
            return byId.get(idKey);
        }

        const detailsKey =
            `${source}|${normalizeName(transaction.what)}|` +
            `${Number(transaction.sum)}|` +
            `${String(transaction.currency || "").toUpperCase()}`;

        const matches = byDetails.get(detailsKey);

        if (matches && matches.length) {
            return matches.some(included => included);
        }

        return true;
    });

    /*
     * Streamlabs donations never appear in the DonatePay/DonationAlerts
     * lists, so they are taken straight from the goal server.
     */
    if (control.sourceEnabled.streamlabs !== false) {
        for (const d of control.donations) {
            if (
                normalizeName(d.source) !== "streamlabs" ||
                d.included === false
            ) {
                continue;
            }

            const date = new Date(d.date);

            if (Number.isNaN(date.getTime())) {
                continue;
            }

            filtered.push({
                id: `sl_${stripIdPrefix(d.id)}`,
                source: "Streamlabs",
                type: "donation",
                status: "success",
                what: d.name,
                vars: { name: d.name },
                sum: d.amount,
                currency: d.currency,
                comment: d.message || "",
                created_at: date.toISOString()
            });
        }
    }

    filtered.sort(
        (a, b) =>
            new Date(b.created_at).getTime() -
            new Date(a.created_at).getTime()
    );

    return { ...result, data: filtered };
}

/*
 * RAW list.
 * The goal server (port 3000) reads this one, so it must stay unfiltered.
 */
app.get("/api/transactions", async (req, res) => {
    try {
        res.json(await getTransactions());
    } catch (error) {
        console.error(
            "Donation transactions error:",
            error
        );

        if (cachedTransactions !== null) {
            console.log(
                "Using cached transaction data."
            );

            return res.json(cachedTransactions);
        }

        res.status(500).json({
            error: "Donation API returned an error",
            status: 500,
            response: error.message
        });
    }
});

/*
 * FILTERED list for the scrolling names overlay.
 * Follows the goal admin panel: source ON/OFF and donation Y/N.
 */
app.get("/api/names", async (req, res) => {
    try {
        const result = await getTransactions();
        const control = await getGoalControl();

        res.json(applyGoalControl(result, control));
    } catch (error) {
        console.error(
            "Names transactions error:",
            error
        );

        if (cachedTransactions !== null) {
            return res.json(
                applyGoalControl(
                    cachedTransactions,
                    await getGoalControl()
                )
            );
        }

        res.status(500).json({
            error: "Donation API returned an error",
            status: 500,
            response: error.message
        });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(
        `DonatePayNames running at http://localhost:${PORT}`
    );

    console.log(
        `DonationAlerts: ${DONATIONALERTS_ENABLED ? "ENABLED" : "DISABLED"}`
    );

    console.log(
        `Streamlabs: ${STREAMLABS_ENABLED ? "ENABLED" : "DISABLED"}`
    );

    startStreamlabsSocket();
});
