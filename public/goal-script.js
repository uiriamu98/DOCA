/* Settings */
const POLL_INTERVAL_MS = 30000;
const RAINBOW_DELAY_MS = 6677;

/* Elements */
const goalElement = document.getElementById("goal");
const raisedElement = document.getElementById("raised");
const fillElement = document.getElementById("fill");
const titleElement = document.querySelector(".title");
const goalContainer = goalElement.closest(".goal");
let CAD_GOAL = Number(goalElement.textContent.trim());

/* Audio */
const rainbowSound = new Audio("./Audio/rainbow.mp3");
rainbowSound.preload = "auto";
rainbowSound.volume = Math.pow(10, -12 / 20);

/* State */
let goalWasComplete = false;
let rainbowTimer = null;

/* Rainbow */
function startRainbowCelebration() {
    fillElement.classList.add("complete");
    goalContainer.classList.remove("rainbow-waiting");
    rainbowSound.currentTime = 0;
    rainbowSound.play().catch(error => {
        console.error("Could not play rainbow.mp3:", error);
    });

    console.log("Rainbow celebration started!");
}

/* Look (set from the admin page) */
let rainbowEnabled = true;

function applyOverlayStyle(style) {
    const look = style && style.goal;

    if (!look) {
        return;
    }

    const root = document.documentElement.style;

    root.setProperty("--goal-fill-color", look.fillColor);
if (look.textColor) root.setProperty("--goal-text-color", look.textColor);
    root.setProperty("--goal-bar-color", look.barColor);
    root.setProperty("--goal-bar-height", look.barHeight + "px");
    root.setProperty("--goal-width", look.width + "px");
    document.documentElement.style.opacity = look.enabled === false ? "0" : "";

    const wantRainbow = look.rainbow !== false && look.enabled !== false;

    if (wantRainbow === rainbowEnabled) {
        return;
    }

    rainbowEnabled = wantRainbow;

    if (rainbowEnabled) {
        updateDonationGoal();
        return;
    }

    /* Rainbow switched OFF: stop anything that is running */
    goalWasComplete = false;

    if (rainbowTimer !== null) {
        clearTimeout(rainbowTimer);
        rainbowTimer = null;
    }

    goalContainer.classList.remove("rainbow-waiting");
    fillElement.classList.remove("complete");
    rainbowSound.pause();
    rainbowSound.currentTime = 0;
}

async function updateOverlayStyle() {
    try {
        const response = await fetch("/api/style?t=" + Date.now(), {
            cache: "no-store"
        });

        if (!response.ok) {
            return;
        }

        applyOverlayStyle(await response.json());
    } catch (error) {
        console.error("Could not update overlay look:", error);
    }
}

/* Update */
async function updateDonationGoal() {
    try {
        const response = await fetch("/api/goal?t=" + Date.now(), {
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error(`Server responded with ${response.status}`);
        }

        const data = await response.json();

        if (data.status !== "success") {
            throw new Error(data.error || "Goal server returned an error");
        }

        const cadTotal = Number(data.totalCAD);

        if (!Number.isFinite(cadTotal)) {
            throw new Error("Invalid CAD total");
        }

        /* Goal name and amount (set from the admin page) */
        const serverGoal = Number(data.goal);

        if (Number.isFinite(serverGoal) && serverGoal > 0) {
            CAD_GOAL = serverGoal;
            goalElement.textContent = CAD_GOAL.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        if (typeof data.name === "string" && data.name.trim() !== "") {
            titleElement.textContent = data.name;
        }

        const currencyLabel = document.getElementById("currencyLabel");
        if (currencyLabel) {
            currencyLabel.textContent = data.targetCurrency || "CAD";
        }

        /* Total */
        raisedElement.textContent = cadTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        /* Progress */
        const percentage = Math.min((cadTotal / CAD_GOAL) * 100, 100);
        fillElement.style.width = percentage + "%";

        /* Complete */
        if (cadTotal >= CAD_GOAL) {
            if (rainbowEnabled && !goalWasComplete) {
                goalWasComplete = true;
                goalContainer.classList.add("rainbow-waiting");
                console.log("Goal reached! Rainbow starts in 6.7 seconds...");

                rainbowTimer = setTimeout(() => {
                    rainbowTimer = null;
                    startRainbowCelebration();
                }, RAINBOW_DELAY_MS);
            }
        } else {
            goalWasComplete = false;

            if (rainbowTimer !== null) {
                clearTimeout(rainbowTimer);
                rainbowTimer = null;
            }
            goalContainer.classList.remove("rainbow-waiting");
            fillElement.classList.remove("complete");
            rainbowSound.pause();
            rainbowSound.currentTime = 0;
        }

        console.log(`Donation Goal: ${cadTotal.toFixed(2)} / ${CAD_GOAL} CAD`);
    } catch (error) {
        console.error("Could not update DonatePay goal:", error);
    }
}

/* Start */
updateDonationGoal();
setInterval(updateDonationGoal, POLL_INTERVAL_MS);

updateOverlayStyle();
setInterval(updateOverlayStyle, 3000);
