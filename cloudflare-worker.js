const ANALYZE_PATHS = new Set([
  "/api/analyze",
  "/api/analyze-floor-plan",
  "/api/detect-rooms",
  "/api/extract-room-crops"
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/upload-floor-plan") {
      return withCors(json({
        ok: true,
        message: "Upload is handled by the multipart /api/analyze-floor-plan request in this version."
      }));
    }

    if (!ANALYZE_PATHS.has(url.pathname)) {
      return withCors(json({
        error: "Unknown API endpoint.",
        endpoints: [
          "POST /api/upload-floor-plan",
          "POST /api/analyze-floor-plan",
          "POST /api/detect-rooms",
          "POST /api/extract-room-crops"
        ]
      }, 404));
    }

    if (request.method !== "POST") {
      return withCors(json({ error: "Method not allowed" }, 405));
    }

    try {
      if (!env.GEMINI_API_KEY) {
        return withCors(json({ error: "Missing GEMINI_API_KEY in Worker environment variables." }, 500));
      }

      const form = await request.formData();
      const file = form.get("file");
      const payloadText = form.get("payload") || "{}";
      const payload = JSON.parse(payloadText);

      if (!file || typeof file === "string") {
        return withCors(json({ error: "No drawing file uploaded." }, 400));
      }

      const fileName = file.name || "drawing";
      const mimeType = file.type || guessMimeType(fileName);

      if (!supportedByGemini(mimeType, fileName)) {
        return withCors(json({
          error: "This file type needs backend conversion before Gemini analysis.",
          fileName,
          mimeType,
          nextStep: "Convert CAD/native/model files into PDF or high-resolution PNG, then upload again."
        }, 415));
      }

      const fileBytes = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(fileBytes);
      const model = chooseModel(payload, env);
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
      const prompt = buildPrompt(payload, fileName, mimeType);

      const geminiResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: base64 } }
            ]
          }],
          generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.1
          }
        })
      });

      const geminiText = await geminiResponse.text();
      if (!geminiResponse.ok) {
        return withCors(json({
          error: "Gemini request failed.",
          status: geminiResponse.status,
          detail: geminiText
        }, 502));
      }

      const parsed = parseGeminiJson(geminiText);
      return withCors(json(normalizeResponse(parsed, geminiText)));
    } catch (error) {
      return withCors(json({ error: error.message || "Worker error" }, 500));
    }
  }
};

function chooseModel(payload, env) {
  return (payload?.ai?.modelName || env.GEMINI_MODEL || "gemini-3.5-flash").trim();
}

function buildPrompt(payload, fileName, mimeType) {
  const language = payload.language === "zh" ? "Chinese" : "English";
  return `
You are a construction-estimation vision assistant for a Malaysian tiling contractor.

Analyze the uploaded floor plan image/PDF and return ONLY valid JSON. Do not wrap it in markdown.
Response language for summary, roomName and aiWarning: ${language}.
If response language is Chinese, do not return English room names or English aiWarning text unless it is a technical file name or drawing label.

Important honesty rules:
- Use the actual uploaded drawing only. Do not return template/sample/fake rooms.
- If the drawing contains printed area labels such as "7.8m²", prefer those labels over guessing from pixels.
- If printed side dimensions are visible, return length and width in metres.
- If scale, boundaries, or room labels are unclear, lower confidence and explain the uncertainty in aiWarning.
- Do not invent high precision. Use 1-2 decimal places for areas.
- Bounding boxes may be approximate, but must be normalized to the uploaded image/page: x/y/width/height from 0 to 1.
- Classify shapeType from the actual room floor boundary only. Ignore door swing arcs, beds, sofas, tables, cabinets, bathroom fixtures and furniture when deciding shape.
- A rectangular room with a door swing arc or furniture is still "Rectangle". Use "L-Shape" only when the room wall/perimeter itself clearly forms an L-shaped floor area.

File:
- name: ${fileName}
- mime type: ${mimeType}

Project context:
${JSON.stringify(payload.project || {}, null, 2)}

Material settings:
${JSON.stringify(payload.settings || {}, null, 2)}

Labour and risk context:
${JSON.stringify({ labour: payload.labour || {}, risk: payload.risk || {} }, null, 2)}

Return exactly this JSON object:
{
  "summary": "short contractor-facing summary",
  "rooms": [
    {
      "roomName": "Living / Dining",
      "roomType": "Living Room | Bedroom | Kitchen | Bathroom | Corridor | Balcony | Office | Other",
      "shapeType": "Rectangle | Column Cutout | L-Shape | U-Shape | Polygon | Hexagon | Hollow Area | Manual Area",
      "grossArea": 24.1,
      "deductedArea": 0,
      "netArea": 24.1,
      "length": 5.70,
      "width": 4.23,
      "confidence": 0,
      "bbox": { "x": 0.10, "y": 0.20, "width": 0.30, "height": 0.40, "unit": "ratio" },
      "obstacles": [
        { "type": "Column | Void Area | Staircase | Fixed Cabinet | Island Counter | Other Obstacle", "area": 0.35 }
      ],
      "aiWarning": "manual verification needed when dimensions are unclear"
    }
  ],
  "drawingWarnings": ["missing scale"],
  "workflowNotes": ["import detected rooms and manually correct before quotation"]
}

Area logic:
- grossArea is the full room floor area before obstacle deductions.
- deductedArea is the total of columns, voids, fixed cabinets, stairs, islands or non-tiled areas.
- netArea = grossArea - deductedArea.
- length and width are the best readable side dimensions in metres. If the room is irregular and no clear dimensions are printed, estimate from the room bounding box and lower confidence.
- If skirting is visible or required, mention it in aiWarning, but do not add it into floor netArea.
- For irregular rooms, use Polygon and reduce confidence.
`;
}

function normalizeResponse(data, rawText) {
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  return {
    summary: data.summary || "Gemini analysis completed.",
    rooms: rooms.map((room, index) => normalizeRoom(room, index)),
    drawingWarnings: data.drawingWarnings || data.drawing_warnings || [],
    workflowNotes: data.workflowNotes || data.workflow_notes || [],
    materialNotes: data.materialNotes || data.material_notes || [],
    weatherNotes: data.weatherNotes || data.weather_notes || [],
    raw: rawText
  };
}

function normalizeRoom(room, index) {
  const gross = safeNumber(room.grossArea ?? room.gross_area_m2 ?? room.area ?? room.netArea ?? room.net_area_m2, 0);
  const deduction = safeNumber(room.deductedArea ?? room.deduction_area_m2 ?? room.deducted_area, 0);
  const net = safeNumber(room.netArea ?? room.net_area_m2 ?? room.area, Math.max(0, gross - deduction));
  const length = safeNumber(room.length ?? room.roomLength ?? room.lengthM ?? room.length_m ?? room.dimensions?.length ?? room.dimensions?.lengthM, 0);
  const width = safeNumber(room.width ?? room.roomWidth ?? room.widthM ?? room.width_m ?? room.dimensions?.width ?? room.dimensions?.widthM, 0);
  const confidenceRaw = safeNumber(room.confidence ?? room.confidence_score, 0);
  const confidence = confidenceRaw <= 1 ? confidenceRaw * 100 : confidenceRaw;
  const warnings = [
    ...(Array.isArray(room.warnings) ? room.warnings : []),
    room.aiWarning || room.ai_warning || ""
  ].filter(Boolean);

  return {
    roomName: room.roomName || room.room_name || room.name || `Room ${index + 1}`,
    roomType: room.roomType || room.room_type || "Other",
    shapeType: room.shapeType || room.shape_type || room.shape || "Manual Area",
    grossArea: roundArea(gross),
    deductedArea: roundArea(deduction),
    netArea: roundArea(net),
    length: roundArea(length),
    width: roundArea(width),
    confidence: Math.max(0, Math.min(100, confidence)),
    bbox: normalizeBBox(room.bbox || room.boundingBox || room.bounding_box),
    obstacles: Array.isArray(room.obstacles) ? room.obstacles.map(normalizeObstacle) : [],
    aiWarning: warnings.join(" ")
  };
}

function normalizeObstacle(obstacle) {
  return {
    type: obstacle.type || obstacle.obstacleType || "Other Obstacle",
    area: roundArea(safeNumber(obstacle.area ?? obstacle.area_m2, 0))
  };
}

function normalizeBBox(bbox) {
  if (!bbox) return null;
  const x = safeNumber(bbox.x ?? bbox.left ?? bbox.x1, 0);
  const y = safeNumber(bbox.y ?? bbox.top ?? bbox.y1, 0);
  const width = safeNumber(bbox.width ?? bbox.w ?? ((bbox.x2 ?? bbox.right) - x), 0);
  const height = safeNumber(bbox.height ?? bbox.h ?? ((bbox.y2 ?? bbox.bottom) - y), 0);
  if (width <= 0 || height <= 0) return null;
  const safeX = clamp01(x);
  const safeY = clamp01(y);
  return {
    x: safeX,
    y: safeY,
    width: Math.min(clamp01(width), Math.max(0.001, 1 - safeX)),
    height: Math.min(clamp01(height), Math.max(0.001, 1 - safeY)),
    unit: bbox.unit || "ratio"
  };
}

function parseGeminiJson(text) {
  const envelope = JSON.parse(text);
  const candidateText = envelope.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("") || text;
  try {
    return JSON.parse(candidateText);
  } catch {
    const match = candidateText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Gemini did not return JSON.");
    return JSON.parse(match[0]);
  }
}

function supportedByGemini(mimeType, fileName) {
  const lower = fileName.toLowerCase();
  if (/(\.dwg|\.dxf|\.ifc|\.rvt|\.skp|\.cad)$/.test(lower)) return false;
  return [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/heic",
    "image/heif"
  ].includes(mimeType);
}

function guessMimeType(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  return "application/octet-stream";
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundArea(value) {
  return Math.round(safeNumber(value) * 100) / 100;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, safeNumber(value)));
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json;charset=utf-8" }
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
