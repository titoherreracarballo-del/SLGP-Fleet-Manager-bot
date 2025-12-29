const express = require('express');
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs');
const app = express();
const port = process.env.PORT || 3000;

app.use(fileUpload());
app.use('/files', express.static(path.join(__dirname, 'public')));

// THE FLEET HEALTH CHECK UI (v1.0.9)
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>SLGP Fleet Health Check v1.1.0</title>
    <style>
        /* */
        :root { --brand-blue: #0066ff; --brand-dark: #0a0e17; --card-bg: rgba(255, 255, 255, 0.05); --text-main: #ffffff; --text-dim: #a0a0a0; }
        body { font-family: -apple-system, sans-serif; background-color: var(--brand-dark); color: var(--text-main); margin: 0; padding: 15px; display: flex; justify-content: center; min-height: 100vh; }
        .container { width: 100%; max-width: 420px; }
        .logo-container { text-align: center; margin-bottom: 20px; }
        .logo-container img { width: 100%; max-width: 280px; filter: drop-shadow(0 0 15px rgba(0, 102, 255, 0.4)); }
        .card { background: var(--card-bg); backdrop-filter: blur(20px); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 28px; padding: 25px; box-shadow: 0 25px 50px rgba(0, 0, 0, 0.5); }
        h2 { font-size: 16px; font-weight: 800; text-align: center; margin-bottom: 20px; color: var(--brand-blue); text-transform: uppercase; }
        .form-group { margin-bottom: 20px; }
        label { display: block; font-size: 10px; font-weight: 700; color: var(--brand-blue); margin-bottom: 8px; text-transform: uppercase; }
        input[type="text"], input[type="tel"] { width: 100%; padding: 16px; background: rgba(0, 0, 0, 0.4); border: 1.5px solid rgba(255, 255, 255, 0.1); border-radius: 12px; color: white; font-size: 16px; box-sizing: border-box; }
        .toggle-group { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
        .toggle-btn { flex: 1 1 calc(50% - 8px); padding: 14px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; color: var(--text-dim); text-align: center; font-size: 11px; text-transform: uppercase; cursor: pointer; }
        .toggle-btn.active { background: linear-gradient(135deg, #0066ff, #0044cc) !important; color: white !important; box-shadow: 0 4px 15px rgba(0, 102, 255, 0.6); }
        .upload-area { background: rgba(255, 255, 255, 0.02); border: 2px dashed rgba(255, 255, 255, 0.15); border-radius: 14px; padding: 25px 15px; text-align: center; cursor: pointer; margin-bottom: 15px; position: relative; }
        #progressContainer { width: 100%; background: rgba(255,255,255,0.1); border-radius: 10px; height: 10px; margin: 15px 0; display: none; overflow: hidden; }
        #progressBar { width: 0%; height: 100%; background: linear-gradient(90deg, #0066ff, #4ade80); transition: width 0.3s; }
        #submitBtn { background: linear-gradient(135deg, #0066ff, #0044cc); color: white; border: none; padding: 18px; border-radius: 14px; width: 100%; font-size: 15px; font-weight: 800; text-transform: uppercase; cursor: pointer; }
    </style>
</head>
<body>
<div class="container">
    <div class="logo-container">
        <img src="https://drive.google.com/uc?export=view&id=18gA46HsHYlAViN39iA8Sx9fVLwqPTYPf" alt="Strategic Logistics">
    </div>

    <div class="card" id="mainCard">
        <h2>Fleet Health Check</h2>
        <div class="form-group"><label>Driver Full Name</label><input type="text" id="driverName" placeholder="Enter your name"></div>
        <div class="form-group"><label>Last 4 of VIN</label><input type="tel" id="vin" placeholder="Type 4 digits" maxlength="4" oninput="autoDetectVehicle()"></div>
        
        <label>Service Type</label>
        <div class="toggle-group" id="groupVehicle">
            <div class="toggle-btn" id="v_EDV">EDV</div><div class="toggle-btn" id="v_CDV">CDV</div><div class="toggle-btn" id="v_Cargo">Cargo</div><div class="toggle-btn" id="v_Rental">Rental</div>
        </div>

        <label>Inspection Type</label>
        <div class="toggle-group"><div class="toggle-btn" id="btnPre" onclick="manualSet('Precheck')">Precheck</div><div class="toggle-btn" id="btnPost" onclick="manualSet('Postcheck')">Postcheck</div></div>

        <label>Video Sync (NO 25MB LIMIT)</label>
        <div class="upload-area" id="uploadBox">
            <div id="fileLabel"><span>Record Walkaround Video</span><br><span style="font-size: 9px; color: #4ade80;">UNLIMITED FILE SIZE - POWERED BY MESH SERVER</span></div>
            <input type="file" id="videoFile" accept="video/*" capture="environment">
        </div>

        <div id="progressContainer"><div id="progressBar"></div></div>
        <button id="submitBtn">TRANSMIT TO SLGP MESH</button>
        <div id="status" style="text-align:center; font-size:11px; margin-top:10px;">System Online</div>
    </div>
</div>

<script>
    const FLEET_MAP = ${JSON.stringify({
        '7867': 'Electric RPV Medium', '7871': 'Electric RPV Medium', '9412': 'Electric RPV Medium',
        '7866': 'Electric RPV Medium', '7865': 'Electric RPV Medium', '7860': 'Electric RPV Medium',
        '9418': 'Electric RPV Medium', '7863': 'Electric RPV Medium', '7859': 'Electric RPV Medium',
        '7857': 'Electric RPV Medium', '4905': 'CDV 16ft', '7097': 'CDV 12ft', '5311': 'CDV 16ft',
        '1587': 'CDV 16ft', '2347': 'CDV 16ft', '3880': 'CDV 16ft', '6907': 'CDV 12ft'
    })};

    let inspectionType = '';
    let serviceTypeStr = '';

    function autoDetectVehicle() {
        const vin = document.getElementById('vin').value;
        const btnList = document.querySelectorAll('#groupVehicle .toggle-btn');
        btnList.forEach(b => b.classList.remove('active'));
        if (vin.length === 4) {
            serviceTypeStr = FLEET_MAP[vin] || 'Rental/External';
            if (serviceTypeStr.includes('Electric')) document.getElementById('v_EDV').classList.add('active');
            else if (serviceTypeStr.includes('CDV')) document.getElementById('v_CDV').classList.add('active');
            else if (serviceTypeStr.includes('Rental')) document.getElementById('v_Rental').classList.add('active');
            else document.getElementById('v_Cargo').classList.add('active');
        }
    }

    function manualSet(type) {
        inspectionType = type;
        document.getElementById('btnPre').classList.toggle('active', type === 'Precheck');
        document.getElementById('btnPost').classList.toggle('active', type === 'Postcheck');
    }

    document.getElementById('submitBtn').onclick = async () => {
        const name = document.getElementById('driverName').value;
        const vin = document.getElementById('vin').value;
        const file = document.getElementById('videoFile').files[0];
        if (!name || !vin || !file) { alert("Please complete all fields."); return; }

        document.getElementById('progressContainer').style.display = 'block';
        const formData = new FormData();
        formData.append('meshFile', file);
        formData.append('driver', name);
        formData.append('vin', vin);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/upload'); //
        xhr.upload.onprogress = (e) => {
            const percent = Math.round((e.loaded / e.total) * 100);
            document.getElementById('progressBar').style.width = percent + '%';
        };
        xhr.onload = () => { alert("Sync Complete! File hosted on slgpmeshserver.com"); location.reload(); };
        xhr.send(formData);
    };
</script>
</body>
</html>
  `);
});

// BACK-END MESH LOGIC (Bypasses Discord 25MB)
app.post('/upload', (req, res) => {
  if (!req.files) return res.status(400).send('No file.');
  let meshFile = req.files.meshFile;
  let uploadPath = path.join(__dirname, 'public', meshFile.name);
  meshFile.mv(uploadPath, (err) => {
    if (err) return res.status(500).send(err);
    res.send({ link: \`https://slgpmeshserver.com/files/\${meshFile.name}\` });
  });
});

app.listen(port, '0.0.0.0', () => console.log(\`SLGP Mesh v1.1.0 active on port \${port}\`));