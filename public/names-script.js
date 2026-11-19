/* Settings */
const POLL_INTERVAL_MS = 45000;

const DONOR_FADE_DURATION_MS = 6000;
const STARTUP_HOLD_MS = 6700;
const LABEL_FADE_MS = 350;
const LABEL_DELAY_MS = 325;

const COIN_SOUND = "./Audio/coin.mp3.wav";

const COIN_VOLUME_1 = 0.251;
const COIN_VOLUME_2 = 0.224;
const COIN_VOLUME_3 = 0.200;

const LAST_24_HOURS_MS = 24 * 60 * 60 * 1000;
const LAST_31_DAYS_MS = 31 * 24 * 60 * 60 * 1000;
const LAST_365_DAYS_MS = 365 * 24 * 60 * 60 * 1000;

/* Elements */
const transactionsElement =
    document.getElementById("transactions");

const monthlyTransactionsElement =
    document.getElementById("monthly-transactions");

const recentTransactionsElement =
    document.getElementById("recent-transactions");

/* State */
let donors = [];
let monthlyDonors = [];
let recentDonors = [];

let currentIndex = 0;
let monthlyIndex = 0;
let recentIndex = 0;

let yearComplete = false;
let monthComplete = false;
let dayComplete = false;

let resetArmed = false;

let displayTimer = null;
let monthlyDisplayTimer = null;
let recentDisplayTimer = null;

let introHoldTimer = null;
let introTimer1 = null;
let introTimer2 = null;
let introFinishTimer = null;

let introRunning = false;
let cycleStarted = false;

/* Build separate 24h, 31d and 365d donation buckets.
   Donations graduate individually.
   The 365d expiry resets whenever a donation graduates into it. */
function buildDonorBuckets(transactions, now) {
    const groups = new Map();

    for (const transaction of transactions) {
        const rawName = String(
            transaction.what ??
            transaction.vars?.name ??
            ""
        ).trim();

        const name =
            !rawName ||
            ["anonymous", "donations"].includes(rawName.toLowerCase())
                ? "Anonymous"
                : rawName;

        const currency = String(
            transaction.currency || ""
        ).toUpperCase();

        const key = `${name.toLowerCase()}|${currency}`;

        if (!groups.has(key)) {
            groups.set(key, []);
        }

        groups.get(key).push({
            ...transaction,
            what: name,
            currency,
            time: new Date(transaction.created_at).getTime()
        });
    }

    const recent = [];
    const monthly = [];
    const yearly = [];

    for (const donations of groups.values()) {
        donations.sort((a, b) => a.time - b.time);

        const recentDonations = [];
        const monthlyDonations = [];
        const graduatedDonations = [];

        for (const donation of donations) {
            const age = now - donation.time;

            if (age <= LAST_24_HOURS_MS) {
                recentDonations.push(donation);
            } else if (age <= LAST_31_DAYS_MS) {
                monthlyDonations.push(donation);
            } else {
                graduatedDonations.push({
                    ...donation,
                    graduationTime:
                        donation.time + LAST_31_DAYS_MS
                });
            }
        }

        /* Add all donations in a category into one donor total */
        function makeBucket(bucketDonations, extra = {}) {
            if (bucketDonations.length === 0) {
                return null;
            }

            const firstDonation = bucketDonations[0];
            const latestDonation =
                bucketDonations[bucketDonations.length - 1];

            const sum = bucketDonations.reduce(
                (total, donation) =>
                    total + (Number(donation.sum) || 0),
                0
            );

            return {
                ...latestDonation,
                sum,
                firstDonationAt: firstDonation.created_at,
                lastDonationAt: latestDonation.created_at,
                ...extra
            };
        }

        const recentBucket = makeBucket(recentDonations);
        const monthlyBucket = makeBucket(monthlyDonations);

        if (recentBucket) {
            recent.push(recentBucket);
        }

        if (monthlyBucket) {
            monthly.push(monthlyBucket);
        }

        /* Sort donations by the moment they graduate into 365d */
        graduatedDonations.sort(
            (a, b) => a.graduationTime - b.graduationTime
        );

        /*
         * A gap of more than 365 days between graduations
         * expires the previous 365d accumulation.
         */
        let activeYearDonations = [];
        let previousGraduationTime = null;

        for (const donation of graduatedDonations) {
            if (
                previousGraduationTime !== null &&
                donation.graduationTime - previousGraduationTime >
                    LAST_365_DAYS_MS
            ) {
                activeYearDonations = [];
            }

            activeYearDonations.push(donation);
            previousGraduationTime = donation.graduationTime;
        }

        if (activeYearDonations.length > 0) {
            const latestGraduation =
                activeYearDonations[
                    activeYearDonations.length - 1
                ].graduationTime;

            /* The entire 365d total expires 365 days after
               the latest donation added to that total. */
            if (now - latestGraduation <= LAST_365_DAYS_MS) {
                const yearBucket = makeBucket(
                    activeYearDonations,
                    {
                        lastAddedAt: latestGraduation
                    }
                );

                if (yearBucket) {
                    yearly.push(yearBucket);
                }
            }
        }
    }

    return {
        recent,
        monthly,
        yearly
    };
}

/* Fetch transactions */
async function fetchTransactions() {
    try {
        const response = await fetch(
            "/api/names?t=" + Date.now(),
            {
                cache: "no-store"
            }
        );

        if (!response.ok) {
            throw new Error(
                `Server responded with ${response.status}`
            );
        }

        const data = await response.json();

        const transactions = Array.isArray(data.data)
            ? data.data
            : [];

        const now = Date.now();

        const validDonations = transactions
            .filter((transaction) => {
                if (
                    transaction.type !== "donation" ||
                    transaction.status !== "success"
                ) {
                    return false;
                }

                const time = new Date(
                    transaction.created_at
                ).getTime();

                return (
                    Number.isFinite(time) &&
                    time <= now
                );
            })
            .sort((a, b) =>
                new Date(b.created_at).getTime() -
                new Date(a.created_at).getTime()
            );

        /* Build separate donation buckets */
        const buckets = buildDonorBuckets(
            validDonations,
            now
        );

        recentDonors = buckets.recent;
        monthlyDonors = buckets.monthly;
        donors = buckets.yearly;

        if (currentIndex >= donors.length) {
            currentIndex = 0;
        }

        if (monthlyIndex >= monthlyDonors.length) {
            monthlyIndex = 0;
        }

        if (recentIndex >= recentDonors.length) {
            recentIndex = 0;
        }

        updateFinalDayAppearance();

        if (
            !introRunning &&
            !cycleStarted &&
            hasAnyDonors()
        ) {
            startCycle();
        }

    } catch (error) {
        console.error(
            "Failed to fetch transactions:",
            error
        );
    }
}

/* Donor counts */
function hasAnyDonors() {
    return (
        donors.length +
        monthlyDonors.length +
        recentDonors.length
    ) > 0;
}

/* Final-day detection */
function isFinalDay(donor, category) {
    const now = Date.now();

    if (category === "24h") {
        return false;
    }

    if (category === "31d") {
        const firstTime = new Date(
            donor.firstDonationAt ?? donor.created_at
        ).getTime();

        if (!Number.isFinite(firstTime)) {
            return false;
        }

        const age = now - firstTime;

        return (
            age > LAST_31_DAYS_MS - LAST_24_HOURS_MS &&
            age <= LAST_31_DAYS_MS
        );
    }

    if (category === "365d") {
        const lastAddedTime = new Date(
            donor.lastAddedAt
        ).getTime();

        if (!Number.isFinite(lastAddedTime)) {
            return false;
        }

        const age = now - lastAddedTime;

        return (
            age > LAST_365_DAYS_MS - LAST_24_HOURS_MS &&
            age <= LAST_365_DAYS_MS
        );
    }

    return false;
}

/* Update final-day appearance */
function updateFinalDayAppearance() {
    const entries = [
        {
            element: transactionsElement,
            donor: donors[currentIndex],
            category: "365d"
        },
        {
            element: monthlyTransactionsElement,
            donor: monthlyDonors[monthlyIndex],
            category: "31d"
        },
        {
            element: recentTransactionsElement,
            donor: recentDonors[recentIndex],
            category: "24h"
        }
    ];

    for (const entry of entries) {
        const donation =
            entry.element.querySelector(".donation");

        if (!donation || !entry.donor) {
            continue;
        }

        donation.classList.toggle(
            "final-day",
            isFinalDay(
                entry.donor,
                entry.category
            )
        );
    }
}

/* Audio */
function playCoin(volume) {
    if (document.documentElement.style.opacity === "0") {
        return;
    }

    const sound = new Audio(COIN_SOUND);

    sound.volume = Math.max(
        0,
        Math.min(1, volume)
    );

    sound.play().catch(() => {});
}

/* Clear timers */
function clearAllTimers() {
    clearTimeout(displayTimer);
    clearTimeout(monthlyDisplayTimer);
    clearTimeout(recentDisplayTimer);

    clearTimeout(introHoldTimer);
    clearTimeout(introTimer1);
    clearTimeout(introTimer2);
    clearTimeout(introFinishTimer);

    displayTimer = null;
    monthlyDisplayTimer = null;
    recentDisplayTimer = null;

    introHoldTimer = null;
    introTimer1 = null;
    introTimer2 = null;
    introFinishTimer = null;
}

/* Clear container elements */
function resetContainers(isLabelState = false) {
    const className = isLabelState ? "label-state" : "";

    transactionsElement.className = className;
    monthlyTransactionsElement.className = className;
    recentTransactionsElement.className = className;

    transactionsElement.textContent = isLabelState ? "365d" : "";
    monthlyTransactionsElement.textContent = isLabelState ? "31d" : "";
    recentTransactionsElement.textContent = isLabelState ? "24h" : "";
}

/* Run introduction sequence */
function runIntroSequence() {
    introHoldTimer = setTimeout(() => {
        playCoin(COIN_VOLUME_1);

        transactionsElement.classList.add(
            "label-fade"
        );

        introTimer1 = setTimeout(() => {
            playCoin(COIN_VOLUME_2);

            monthlyTransactionsElement.classList.add(
                "label-fade"
            );
        }, LABEL_DELAY_MS);

        introTimer2 = setTimeout(() => {
            playCoin(COIN_VOLUME_3);

            recentTransactionsElement.classList.add(
                "label-fade"
            );
        }, LABEL_DELAY_MS * 2);

        introFinishTimer = setTimeout(() => {
            resetContainers(false);
            introRunning = false;

            if (hasAnyDonors()) {
                startCycle();
            }
        }, (LABEL_DELAY_MS * 2) + LABEL_FADE_MS);

    }, STARTUP_HOLD_MS);
}

/* Start synchronized fade cycle */
function startCycle() {
    if (
        introRunning ||
        cycleStarted ||
        !hasAnyDonors()
    ) {
        return;
    }

    cycleStarted = true;
    resetArmed = false;

    currentIndex = 0;
    monthlyIndex = 0;
    recentIndex = 0;

    yearComplete = donors.length === 0;
    monthComplete = monthlyDonors.length === 0;
    dayComplete = recentDonors.length === 0;

    resetContainers(false);

    if (!yearComplete) {
        showCurrentDonor();
    }

    if (!monthComplete) {
        showMonthlyDonor();
    }

    if (!dayComplete) {
        showRecentDonor();
    }

    checkResetReady();
}

/* 365d category */
function showCurrentDonor() {
    clearTimeout(displayTimer);
    displayTimer = null;

    if (
        introRunning ||
        donors.length === 0 ||
        yearComplete
    ) {
        return;
    }

    showDonor(
        transactionsElement,
        donors[currentIndex],
        "365d"
    );

    displayTimer = setTimeout(() => {
        displayTimer = null;
        transactionsElement.textContent = "";

        currentIndex++;

        if (currentIndex >= donors.length) {
            currentIndex = 0;
            yearComplete = true;

            checkResetReady();
            return;
        }

        showCurrentDonor();

    }, DONOR_FADE_DURATION_MS);
}

/* 31d category */
function showMonthlyDonor() {
    clearTimeout(monthlyDisplayTimer);
    monthlyDisplayTimer = null;

    if (
        introRunning ||
        monthlyDonors.length === 0 ||
        monthComplete
    ) {
        return;
    }

    showDonor(
        monthlyTransactionsElement,
        monthlyDonors[monthlyIndex],
        "31d"
    );

    monthlyDisplayTimer = setTimeout(() => {
        monthlyDisplayTimer = null;
        monthlyTransactionsElement.textContent = "";

        monthlyIndex++;

        if (monthlyIndex >= monthlyDonors.length) {
            monthlyIndex = 0;
            monthComplete = true;

            checkResetReady();
            return;
        }

        showMonthlyDonor();

    }, DONOR_FADE_DURATION_MS);
}

/* 24h category */
function showRecentDonor() {
    clearTimeout(recentDisplayTimer);
    recentDisplayTimer = null;

    if (
        introRunning ||
        recentDonors.length === 0 ||
        dayComplete
    ) {
        return;
    }

    showDonor(
        recentTransactionsElement,
        recentDonors[recentIndex],
        "24h"
    );

    recentDisplayTimer = setTimeout(() => {
        recentDisplayTimer = null;
        recentTransactionsElement.textContent = "";

        recentIndex++;

        if (recentIndex >= recentDonors.length) {
            recentIndex = 0;
            dayComplete = true;

            checkResetReady();
            return;
        }

        showRecentDonor();

    }, DONOR_FADE_DURATION_MS);
}

/*
 * Wait until every category finishes.
 * Continuously loops names smoothly without re-triggering the intro.
 */
function checkResetReady() {
    if (
        !cycleStarted ||
        introRunning ||
        resetArmed
    ) {
        return;
    }

    if (
        yearComplete &&
        monthComplete &&
        dayComplete
    ) {
        resetArmed = true;
        resetContainers(false);
        cycleStarted = false;

        if (hasAnyDonors()) {
            startCycle();
        }
    }
}

/* Render donor */
function showDonor(container, donor, category) {
    const rawName = String(
        donor.what ?? donor.vars?.name ?? ""
    ).trim();

    const name =
        rawName.toLowerCase() === "anonymous" ||
        rawName.toLowerCase() === "donations"
            ? "Anonymous"
            : rawName;

    const amountNumber = Number(donor.sum);

    const formattedAmount =
        Number.isFinite(amountNumber)
            ? amountNumber.toString()
            : String(donor.sum || "");

    const currency = donor.currency || "";

    const finalDay = isFinalDay(
        donor,
        category
    );

    const displayText =
        `${name || "Anonymous"} +${formattedAmount} ${currency}`;

    const source =
        String(donor.source || "").toLowerCase();

    const sourceClass =
        source === "donationalerts"
            ? " source-da"
            : source === "donatepay"
                ? " source-dp"
                : source === "streamlabs"
                    ? " source-streamlabs"
                    : "";

    container.innerHTML = `
        <div class="donation${finalDay ? " final-day" : ""}${sourceClass}">
            ${escapeHtml(displayText)}
        </div>
    `;
}

/* Escape HTML */
function escapeHtml(value) {
    const div = document.createElement("div");

    div.textContent = String(value);

    return div.innerHTML;
}

/* Initial OBS introduction */
resetContainers(true);
introRunning = true;

/* Fetch initial donations */
fetchTransactions();

/* First introduction */
runIntroSequence();

/* Poll for new donations */
setInterval(
    fetchTransactions,
    POLL_INTERVAL_MS
);

/* Names overlay ON/OFF & font color (set from the goal admin page) */
(function () {
    async function updateNamesStyle() {
        try {
            const response = await fetch(
                `http://${window.location.hostname}:3000/api/style?t=` + Date.now(),
                { cache: "no-store" }
            );

            if (!response.ok) {
                return;
            }

            const style = await response.json();
            const namesStyle = style.names || {};
            const on = namesStyle.enabled !== false;

            document.documentElement.style.opacity = on ? "" : "0";

            const rawColor = typeof namesStyle.textColor === "string"
                ? namesStyle.textColor.trim()
                : "";
            const customColor = rawColor && !rawColor.startsWith("#")
                ? "#" + rawColor
                : rawColor;

            if (/^#[0-9a-fA-F]{6}$/.test(customColor)) {
                document.documentElement.style.setProperty("--names-text-color", customColor);
                document.body.classList.add("custom-names-color");
            } else {
                document.documentElement.style.removeProperty("--names-text-color");
                document.body.classList.remove("custom-names-color");
            }
        } catch (error) {
            console.error("Could not update names overlay style:", error);
        }
    }

    updateNamesStyle();
    setInterval(updateNamesStyle, 3000);
})();
