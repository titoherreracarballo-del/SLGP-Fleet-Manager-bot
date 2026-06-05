#!/usr/bin/env python3
"""
SLGP Local Damage Detection Engine
Uses OpenCV + Tesseract — zero API calls, zero cost, runs on CPU

Usage:
    python3 analyze_damage.py <image_path> [<image_path2> ...]

Output: JSON to stdout
{
  "overallCondition": "good|fair|poor",
  "damageFound": true|false,
  "items": [{"type": "...", "severity": "...", "location": "...", "description": "..."}],
  "recommendedAction": "none|monitor|repair_soon|repair_immediately",
  "confidenceScore": 0-100,
  "vinDetected": "XXXX|null",
  "notes": "..."
}
"""
import sys
import json
import cv2
import numpy as np
import pytesseract
from PIL import Image

# ── VIN database (last 4 digits → expected vehicle color range) ───────────────
# HSV ranges for each fleet vehicle type
VEHICLE_COLORS = {
    'dark_blue':   ([100, 30, 20],  [130, 255, 120]),
    'white':       ([0,   0,  160], [180, 40,  255]),
    'black':       ([0,   0,  0],   [180, 60,  60]),
    'silver':      ([0,   0,  100], [180, 30,  200]),
    'green':       ([40,  30, 20],  [80,  255, 150]),
}

def analyze_frame(image_path):
    """Run full damage analysis on a single frame."""
    img = cv2.imread(image_path)
    if img is None:
        return None

    h, w = img.shape[:2]
    results = {
        'edge_score':   0,
        'color_score':  0,
        'damage_zones': [],
        'vin_detected': None,
    }

    # ── 1. EDGE DENSITY ANALYSIS — dents, deep scratches ─────────────────────
    # Dents create abnormal edge clusters on otherwise smooth van panels
    gray    = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges   = cv2.Canny(blurred, 40, 120)

    # Divide into grid cells and find cells with abnormally high edge density
    cell_size = 64
    grid_h    = h // cell_size
    grid_w    = w // cell_size
    edge_densities = []

    for gy in range(grid_h):
        for gx in range(grid_w):
            y1, y2 = gy * cell_size, (gy + 1) * cell_size
            x1, x2 = gx * cell_size, (gx + 1) * cell_size
            cell_edges = edges[y1:y2, x1:x2]
            density    = np.sum(cell_edges) / (cell_size * cell_size * 255)
            edge_densities.append((density, gx, gy, x1, y1, x2, y2))

    if edge_densities:
        avg_density  = np.mean([d[0] for d in edge_densities])
        std_density  = np.std([d[0]  for d in edge_densities])
        threshold    = avg_density + 2.5 * std_density

        high_density = [d for d in edge_densities if d[0] > threshold and d[0] > 0.08]

        if high_density:
            results['edge_score'] = min(100, int(len(high_density) * 15))
            for density, gx, gy, x1, y1, x2, y2 in high_density[:3]:
                loc = _classify_location(x1 + cell_size//2, y1 + cell_size//2, w, h)
                results['damage_zones'].append({
                    'type':     'edge_cluster',
                    'x': x1, 'y': y1, 'w': cell_size, 'h': cell_size,
                    'density':  round(float(density), 3),
                    'location': loc,
                })

    # ── 2. COLOR ANOMALY DETECTION — rust, paint damage, discoloration ────────
    hsv       = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    rust_mask = cv2.inRange(hsv,
        np.array([0,  80, 40]),
        np.array([20, 255, 200])
    )
    rust_pct  = np.sum(rust_mask > 0) / (h * w)

    # Detect unusual color patches (paint chips expose primer/metal)
    gray_norm  = gray.astype(float) / 255.0
    sat_chan    = hsv[:, :, 1].astype(float) / 255.0
    # Areas with very low saturation on a colored van = possible primer/bare metal
    primer_mask = (sat_chan < 0.08) & (gray_norm > 0.2) & (gray_norm < 0.7)
    primer_pct  = np.sum(primer_mask) / (h * w)

    color_issues = 0
    if rust_pct > 0.005:
        color_issues += int(rust_pct * 2000)
        # Find rust centroid
        moments = cv2.moments(rust_mask)
        if moments['m00'] > 0:
            cx = int(moments['m10'] / moments['m00'])
            cy = int(moments['m01'] / moments['m00'])
            results['damage_zones'].append({
                'type':     'rust',
                'x': max(0, cx-32), 'y': max(0, cy-32), 'w': 64, 'h': 64,
                'area_pct': round(rust_pct * 100, 2),
                'location': _classify_location(cx, cy, w, h),
            })

    if primer_pct > 0.01:
        color_issues += int(primer_pct * 500)

    results['color_score'] = min(100, color_issues)

    # ── 3. STRUCTURAL ANOMALY — large contours indicating deformation ─────────
    # Fill small gaps and find large irregular contours
    kernel    = np.ones((5, 5), np.uint8)
    edges_dilated = cv2.dilate(edges, kernel, iterations=1)
    contours, _   = cv2.findContours(edges_dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    large_contours = [c for c in contours if cv2.contourArea(c) > 800]
    deform_score   = 0
    for cnt in large_contours[:5]:
        area   = cv2.contourArea(cnt)
        perimeter = cv2.arcLength(cnt, True)
        if perimeter > 0:
            # Circularity — irregular shapes (dents) have low circularity
            circularity = 4 * np.pi * area / (perimeter * perimeter)
            if circularity < 0.3 and area > 1500:
                deform_score += int(area / 200)
                x, y, rw, rh = cv2.boundingRect(cnt)
                results['damage_zones'].append({
                    'type':     'deformation',
                    'x': x, 'y': y, 'w': rw, 'h': rh,
                    'circularity': round(float(circularity), 3),
                    'location': _classify_location(x + rw//2, y + rh//2, w, h),
                })

    results['deform_score'] = min(100, deform_score)

    # ── 4. TESSERACT VIN DETECTION ─────────────────────────────────────────────
    try:
        # Focus on windshield area (top 40% of frame, center 60%)
        roi_y1 = 0
        roi_y2 = int(h * 0.45)
        roi_x1 = int(w * 0.2)
        roi_x2 = int(w * 0.8)
        roi = img[roi_y1:roi_y2, roi_x1:roi_x2]

        # Preprocess for OCR
        roi_gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        roi_up   = cv2.resize(roi_gray, None, fx=2, fy=2, interpolation=cv2.INTER_LANCZOS4)
        _, roi_thresh = cv2.threshold(roi_up, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

        # Run Tesseract with alphanumeric config
        config  = '--psm 11 --oem 3 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
        ocr_out = pytesseract.image_to_string(roi_thresh, config=config).strip()

        # Find 4-digit alphanumeric sequences (VIN last 4)
        import re
        vin_matches = re.findall(r'[A-Z0-9]{4}', ocr_out)
        if vin_matches:
            results['vin_detected'] = vin_matches[0]
    except Exception:
        pass

    return results


def _classify_location(cx, cy, w, h):
    """Map pixel coordinates to vehicle location name."""
    x_pct = cx / w
    y_pct = cy / h

    if y_pct < 0.3:
        vert = 'upper'
    elif y_pct > 0.7:
        vert = 'lower'
    else:
        vert = 'mid'

    if x_pct < 0.3:
        horiz = 'left'
    elif x_pct > 0.7:
        horiz = 'right'
    else:
        horiz = 'center'

    location_map = {
        ('upper', 'center'): 'hood_or_roof',
        ('upper', 'left'):   'driver_side_upper',
        ('upper', 'right'):  'passenger_side_upper',
        ('mid',   'left'):   'driver_side_panel',
        ('mid',   'right'):  'passenger_side_panel',
        ('mid',   'center'): 'center_panel',
        ('lower', 'left'):   'driver_side_lower',
        ('lower', 'right'):  'passenger_side_lower',
        ('lower', 'center'): 'underbody_area',
    }
    return location_map.get((vert, horiz), 'body_panel')


def aggregate_results(frame_results):
    """Combine results from multiple frames into final report."""
    if not frame_results:
        return build_report(0, [], None)

    # Average scores across frames
    edge_scores   = [r['edge_score']   for r in frame_results if r]
    color_scores  = [r['color_score']  for r in frame_results if r]
    deform_scores = [r.get('deform_score', 0) for r in frame_results if r]

    avg_edge   = max(edge_scores)   if edge_scores   else 0
    avg_color  = max(color_scores)  if color_scores  else 0
    avg_deform = max(deform_scores) if deform_scores else 0

    # Composite damage score
    total_score = int(avg_edge * 0.4 + avg_color * 0.35 + avg_deform * 0.25)

    # Collect all damage zones
    all_zones = []
    for r in frame_results:
        if r:
            all_zones.extend(r.get('damage_zones', []))

    # VIN — take first detection across frames
    vin = None
    for r in frame_results:
        if r and r.get('vin_detected'):
            vin = r['vin_detected']
            break

    return build_report(total_score, all_zones, vin)


def build_report(score, zones, vin_detected):
    """Build standardized damage report matching the original Gemini format."""
    items = []
    seen_locations = set()

    for zone in zones:
        loc = zone.get('location', 'body_panel')
        if loc in seen_locations:
            continue
        seen_locations.add(loc)

        ztype = zone['type']
        if ztype == 'rust':
            item_type = 'rust'
            severity  = 'major' if zone.get('area_pct', 0) > 2 else 'moderate'
            desc      = f"Rust detected ({zone.get('area_pct',0):.1f}% of frame area)"
        elif ztype == 'edge_cluster':
            item_type = 'dent_or_scratch'
            severity  = 'moderate' if zone.get('density', 0) > 0.15 else 'minor'
            desc      = f"Abnormal surface texture — possible dent or scratch"
        elif ztype == 'deformation':
            item_type = 'dent'
            circ      = zone.get('circularity', 0.5)
            severity  = 'major' if circ < 0.15 else 'moderate'
            desc      = f"Surface deformation detected"
        else:
            continue

        items.append({
            'type':        item_type,
            'severity':    severity,
            'location':    loc,
            'description': desc,
        })

    # Overall condition
    if score < 15:
        condition = 'good'
        action    = 'none'
    elif score < 35:
        condition = 'fair'
        action    = 'monitor'
    elif score < 60:
        condition = 'fair'
        action    = 'repair_soon'
    else:
        condition = 'poor'
        action    = 'repair_immediately'

    confidence = min(95, max(20, 100 - abs(score - 50) // 2 + len(items) * 5))

    notes_parts = ['OpenCV local analysis (no API)']
    if vin_detected:
        notes_parts.append(f'VIN detected in frame: {vin_detected}')

    return {
        'overallCondition':  condition,
        'damageFound':       len(items) > 0,
        'items':             items,
        'recommendedAction': action,
        'confidenceScore':   confidence,
        'vinDetected':       vin_detected,
        'damageScore':       score,
        'notes':             ' · '.join(notes_parts),
        'source':            'local_opencv',
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: analyze_damage.py <image1> [image2] ...'}))
        sys.exit(1)

    image_paths   = sys.argv[1:]
    frame_results = []

    for path in image_paths:
        try:
            result = analyze_frame(path)
            frame_results.append(result)
        except Exception as e:
            frame_results.append(None)

    report = aggregate_results(frame_results)
    print(json.dumps(report))


if __name__ == '__main__':
    main()
