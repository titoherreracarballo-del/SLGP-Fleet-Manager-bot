<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fleet Health Check</title>
    <style>
        /* --- CORE STYLES --- */
        body {
            background-color: #0f172a;
            color: #38bdf8;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
        }

        .form-container {
            background-color: #1e293b;
            padding: 30px;
            border-radius: 24px;
            width: 100%;
            max-width: 450px;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
            border: 1px solid #334155;
        }

        h1 {
            text-align: center;
            font-size: 1.5rem;
            letter-spacing: 2px;
            margin-bottom: 30px;
            color: #3b82f6;
        }

        .timestamp-display {
            background: rgba(0, 0, 0, 0.3);
            color: #10b981;
            text-align: center;
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 25px;
            font-family: monospace;
            border: 1px solid #064e3b;
        }

        label {
            display: block;
            font-size: 0.75rem;
            font-weight: bold;
            margin-bottom: 8px;
            color: #60a5fa;
            letter-spacing: 1px;
        }

        input {
            width: 100%;
            padding: 15px;
            background-color: #0f172a;
            border: 1px solid #334155;
            border-radius: 12px;
            color: white;
            font-size: 1rem;
            margin-bottom: 25px;
            box-sizing: border-box;
            outline: none;
            transition: border 0.3s;
        }

        input:focus {
            border-color: #3b82f6;
        }

        /* --- BUTTON GROUP STYLES --- */
        .button-group {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-bottom: 25px;
        }

        .btn {
            background-color: #334155;
            color: #94a3b8;
            padding: 18px;
            border-radius: 12px;
            text-align: center;
            font-weight: bold;
            font-size: 0.9rem;
            border: 1px solid #475569;
            transition: all 0.3s ease;
            cursor: pointer;
            text-transform: uppercase;
        }

        /* Active state for auto-selected buttons */
        .active {
            background-color: #2563eb !important;
            color: white !important;
            border-color: #3b82f6 !important;
            box-shadow: 0 0 20px rgba(37, 99, 235, 0.5);
            opacity: 1 !important;
        }

        .upload-section {
            border: 2px dashed #334155;
            border-radius: 15px;
            padding: 40px 20px;
            text-align: center;
            margin-bottom: 30px;
            cursor: pointer;
        }

        .submit-btn {
            width: 100%;
            background-color: #2563eb;
            color: white;
            padding: 20px;
            border-radius: 15px;
            font-weight: bold;
            font-size: 1.1rem;
            border: none;
            cursor: pointer;
            transition: background 0.3s;
        }

        .submit-btn:hover {
            background-color: #1d4ed8;
        }
    </style>
</head>
<body>

    <div class="form-container">
        <h1>FLEET HEALTH CHECK</h1>

        <div id="clock" class="timestamp-display">LOADING SYSTEM TIME...</div>

        <label>DRIVER FULL NAME</label>
        <input type="text" id="driver-name" placeholder="Enter Full Name">

        <label>LAST 4 OF VIN</label>
        <input type="text" id="vin-input" maxlength="4" placeholder="e.g. 3754">

        <label>SERVICE TYPE</label>
        <div class="button-group" id="service-group">
            <div class="service-btn btn">EDV</div>
            <div class="service-btn btn">CDV</div>
            <div class="service-btn btn">CARGO</div>
            <div class="service-btn btn">RENTAL</div>
        </div>

        <label>INSPECTION TYPE (AUTO-SELECTED)</label>
        <div class="button-group" id="inspection-group">
            <div class="inspection-btn btn">PRECHECK</div>
            <div class="inspection-btn btn">POSTCHECK</div>
        </div>

        <div class="upload-section">
            <div style="font-size: 1.2rem; margin-bottom: 5px;">Tap to Record Video</div>
            <div style="font-size: 0.7rem; color: #10b981;">1080p SUPPORTED</div>
        </div>

        <button class="submit-btn">UPLOAD TO GOOGLE DRIVE</button>
    </div>

    <script>
        // 1. FULL DATA LOOKUP (From Spreadsheet Image)
        const vehicleDatabase = {
            // EDV - Electric Rivian
            "7867": "EDV", "7871": "EDV", "9412": "EDV", "7872": "EDV", "7866": "EDV", 
            "7860": "EDV", "9418": "EDV", "7863": "EDV", "7859": "EDV", "7857": "EDV",
            "2785": "EDV", "2786": "EDV", "2787": "EDV", "2788": "EDV", "2789": "EDV",
            
            // CDV - Custom Delivery Vans
            "4905": "CDV", "7097": "CDV", "2347": "CDV", "1587": "CDV", "6880": "CDV", 
            "6907": "CDV", "1295": "CDV", "6265": "CDV", "6188": "CDV", "1288": "CDV", 
            "6864": "CDV", "9234": "CDV", "1368": "CDV", "1412": "CDV", "4626": "CDV",
            
            // CARGO - Large/Extra Large Vans
            "1051": "CARGO", "9488": "CARGO", "7088": "CARGO", "1664": "CARGO", "0871": "CARGO", 
            "3010": "CARGO", "5344": "CARGO", "0890": "CARGO", "5341": "CARGO", "3754": "CARGO", 
            "7373": "CARGO", "0876": "CARGO", "8786": "CARGO", "0213": "CARGO", "3892": "CARGO", 
            "9651": "CARGO", "5691": "CARGO", "9128": "CARGO", "5874": "CARGO", "1410": "CARGO"
        };

        // 2. SELECTION ENGINE
        function triggerAutoSelection(selector, valueToMatch) {
            const buttons = document.querySelectorAll(selector);
            
            buttons.forEach(function(btn) {
                // Reset state
                btn.classList.remove('active');
                
                // LOCK MANUAL OVERRIDE (Buttons cannot be clicked)
                btn.style.pointerEvents = 'none';
                btn.style.opacity = '0.5';

                // Match and activate
                if (btn.innerText.trim().toUpperCase() === valueToMatch.toUpperCase()) {
                    btn.classList.add('active');
                    btn.style.opacity = '1';
                }
            });
        }

        // 3. TIME LOGIC (Shift-based selection)
        function updateTimeAndShift() {
            const now = new Date();
            
            // Update visual clock
            const options = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' };
            document.getElementById('clock').innerText = now.toLocaleString('en-US', options);

            const hours = now.getHours();
            const minutes = now.getMinutes();
            const totalMins = (hours * 60) + minutes;

            // PRECHECK: 10:00 AM (600 mins) to 3:00 PM (900 mins)
            if (totalMins >= 600 && totalMins <= 900) {
                triggerAutoSelection('.inspection-btn', 'PRECHECK');
            } 
            // POSTCHECK: 6:00 PM (1080 mins) to 11:30 PM (1410 mins)
            else if (totalMins >= 1080 && totalMins <= 1410) {
                triggerAutoSelection('.inspection-btn', 'POSTCHECK');
            } 
            else {
                // Outside shift hours - reset buttons
                document.querySelectorAll('.inspection-btn').forEach(btn => btn.classList.remove('active'));
            }
        }

        // 4. INITIALIZATION
        window.addEventListener('load', function() {
            // Start the clock and shift check
            updateTimeAndShift();
            setInterval(updateTimeAndShift, 1000); // Keep time updated

            // VIN Input Listener
            const vinInput = document.getElementById('vin-input');
            if (vinInput) {
                vinInput.addEventListener('input', function(e) {
                    const value = e.target.value;
                    
                    // Look up when exactly 4 digits are entered
                    if (value.length === 4) {
                        const vehicleType = vehicleDatabase[value];
                        if (vehicleType) {
                            triggerAutoSelection('.service-btn', vehicleType);
                        } else {
                            // Default to Rental if not in fleet list (Optional)
                            // triggerAutoSelection('.service-btn', 'RENTAL');
                        }
                    }
                });
            }
        });
    </script>
</body>
</html>
