<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Report Issue - Fleet Health</title>
    <style>
        /* --- THEME SETTINGS --- */
        :root {
            --bg-body: #0F1115;       
            --bg-card: #161B28;       
            --bg-input: #0b0d12;      
            --bg-button: #242c3d;     
            --primary-blue: #2563EB;  
            --text-label: #3B82F6;    
            --text-green: #4ade80;    
            --radius: 12px;           
        }

        body {
            background-color: var(--bg-body);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            justify-content: center;
            padding: 20px;
            margin: 0;
            color: white;
            min-height: 100vh;
        }

        .container {
            width: 100%;
            max-width: 400px; 
            background-color: var(--bg-card);
            border-radius: 24px;
            padding: 24px;
            border: 1px solid #1f2937;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        }

        /* --- HEADER --- */
        .back-link {
            color: #94a3b8;
            text-decoration: none;
            font-size: 14px;
            display: inline-block;
            margin-bottom: 20px;
        }
        .timestamp {
            color: var(--text-green);
            text-align: center;
            font-size: 13px;
            font-weight: 700;
            margin-bottom: 5px;
        }
        h1 {
            color: var(--text-label);
            text-align: center;
            font-size: 24px;
            font-weight: 900;
            text-transform: uppercase;
            margin: 0 0 20px 0;
        }

        /* --- FORMS --- */
        .form-group { margin-bottom: 20px; }

        label {
            color: var(--text-label);
            display: block;
            font-size: 11px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 1.5px;
            margin-bottom: 8px;
        }

        input, textarea {
            width: 100%;
            background-color: var(--bg-input);
            border: 1px solid #1f2937;
            color: white;
            padding: 16px;
            border-radius: var(--radius);
            font-size: 16px;
            box-sizing: border-box; 
            outline: none;
            font-family: inherit;
        }
        input:focus, textarea:focus { border-color: var(--text-label); }

        /* --- BUTTON GRID (UPDATED) --- */
        .grid-options {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }

        .btn-option {
            background-color: var(--bg-button);
            border: 1px solid #374151;
            color: #cbd5e1;
            padding: 12px;
            border-radius: var(--radius);
            font-weight: 700;
            font-size: 12px;
            text-transform: uppercase;
            cursor: pointer;
            transition: background 0.2s;
            text-align: center;
        }

        .btn-option:hover { background-color: #334155; color: white; }
        
        .btn-option.selected {
            background-color: #1e293b;
            border-color: var(--text-label);
            color: white;
            box-shadow: 0 0 10px rgba(59, 130, 246, 0.1);
        }

        /* --- SEVERITY BUTTONS --- */
        .row-split { display: flex; gap: 10px; }
        .row-split .btn-option { width: 100%; font-size: 13px; }

        /* --- CAMERA BOX --- */
        .camera-box {
            border: 2px dashed #374151;
            border-radius: 16px;
            height: 100px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            background-color: rgba(255,255,255,0.02);
        }
        .camera-icon { width: 32px; height: 32px; fill: #64748b; }

        /* --- SUBMIT --- */
        .btn-submit {
            width: 100%;
            background-color: var(--primary-blue);
            color: white;
            border: none;
            padding: 18px;
            font-size: 16px;
            font-weight: 900;
            text-transform: uppercase;
            border-radius: var(--radius);
            cursor: pointer;
            margin-top: 10px;
            box-shadow: 0 4px 20px rgba(37, 99, 235, 0.4);
        }
    </style>
</head>
<body>

    <div class="container">
        <a href="menu.html" class="back-link">← Back to Menu</a>
        
        <div class="timestamp">1/2/2026, 6:55:00 PM</div>
        <h1>Report Issue</h1>

        <div class="form-group">
            <label>Driver Full Name</label>
            <input type="text" placeholder="Enter Name">
        </div>

        <div class="form-group">
            <label>Select Issue(s)</label>
            <div class="grid-options">
                <button class="btn-option">Engine / Check Engine</button>
                <button class="btn-option">Brakes / Noise</button>
                <button class="btn-option">Tires / Flat</button>
                <button class="btn-option">Battery / No Start</button>
                <button class="btn-option">Oil / Fluids</button>
                <button class="btn-option">Lights / Signals</button>
                <button class="btn-option">Body Damage</button>
                <button class="btn-option">Wipers / Glass</button>
            </div>
        </div>

        <div class="form-group">
            <label>Severity Level</label>
            <div class="row-split">
                <button class="btn-option selected">Safe to Drive</button>
                <button class="btn-option" style="color:#ef4444; border-color:rgba(239,68,68,0.4);">DO NOT DRIVE</button>
            </div>
        </div>

        <div class="form-group">
            <label>Description</label>
            <textarea style="min-height: 80px;" placeholder="Describe the noise, error code, or specific details..."></textarea>
        </div>

        <div class="form-group">
            <label>Photo Evidence</label>
            <div class="camera-box">
                <svg class="camera-icon" viewBox="0 0 24 24">
                    <path d="M4 4h3l2-2h6l2 2h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v12h16V6h-2.5L15.5 4h-7L6.5 6H4zm8 11a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/>
                </svg>
            </div>
        </div>

        <button class="btn-submit">Submit Issue Report</button>
    </div>

    <script>
        // Simple script to toggle selection on buttons
        const buttons = document.querySelectorAll('.grid-options .btn-option');
        buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                btn.classList.toggle('selected');
            });
        });
    </script>

</body>
</html>
