// --- 1. VEHICLE DATA LOOKUP (Mapped from your Spreadsheet) ---
const vinLookupTable = {
    // EDV (Electric Rivian)
    "7867": "EDV", "7871": "EDV", "9412": "EDV", "7872": "EDV", "7866": "EDV", "7860": "EDV", "9418": "EDV", "7863": "EDV", "7859": "EDV", "7857": "EDV",
    // CDV (Custom Delivery Vans)
    "4905": "CDV", "7097": "CDV", "2347": "CDV", "1587": "CDV", "6880": "CDV", "6907": "CDV", "1295": "CDV", "6265": "CDV", "6188": "CDV", "1288": "CDV", "6864": "CDV",
    // CARGO (Extra Large/Large Vans)
    "1051": "CARGO", "9488": "CARGO", "7088": "CARGO", "1664": "CARGO", "0871": "CARGO", "3010": "CARGO", "5344": "CARGO", "0890": "CARGO", "5341": "CARGO", "3754": "CARGO", "7373": "CARGO", "0876": "CARGO", "8786": "CARGO", "0213": "CARGO", "3892": "CARGO", "9651": "CARGO", "5691": "CARGO", "9128": "CARGO"
};

// --- 2. AUTO-SELECTION LOGIC ---

function handleVinLookup(event) {
    const vinValue = event.target.value;
    
    // Only triggers when user reaches exactly 4 digits
    if (vinValue.length === 4) {
        const matchedService = vinLookupTable[vinValue];
        if (matchedService) {
            applyAutoSelection('.service-btn', matchedService);
        }
    }
}

function updateInspectionTime() {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const totalMinutes = (hours * 60) + minutes;

    // Fixed Time Windows (Minutes from midnight)
    const preStart = 10 * 60;        // 10:00 AM
    const preEnd = 15 * 60;          // 3:00 PM
    const postStart = 18 * 60;       // 6:00 PM
    const postEnd = (23 * 60) + 30;  // 11:30 PM

    let activeType = null;
    if (totalMinutes >= preStart && totalMinutes <= preEnd) {
        activeType = "PRECHECK";
    } else if (totalMinutes >= postStart && totalMinutes <= postEnd) {
        activeType = "POSTCHECK";
    }

    if (activeType) {
        applyAutoSelection('.inspection-btn', activeType);
    }
}

// Utility to highlight the correct button and LOCK manual clicks
function applyAutoSelection(selector, value) {
    document.querySelectorAll(selector).forEach(btn => {
        btn.classList.remove('active');
        btn.style.pointerEvents = 'none'; // DISABLE MANUAL OVERRIDE
        btn.style.opacity = '0.6';      // Visual cue that it's locked
        
        if (btn.innerText.trim().toUpperCase() === value.toUpperCase()) {
            btn.classList.add('active');
            btn.style.opacity = '1';     // Highlight the active one
        }
    });
}

// --- 3. INITIALIZATION ---
window.addEventListener('DOMContentLoaded', () => {
    // 1. Run time check immediately
    updateInspectionTime();
    
    // 2. Watch for VIN entry (assumes your input ID is 'vin-input')
    const vinInput = document.getElementById('vin-input');
    if (vinInput) {
        vinInput.addEventListener('input', handleVinLookup);
    }
});
