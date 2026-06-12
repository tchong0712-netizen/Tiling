export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname !== "/api/analyze") {
      return env.ASSETS.fetch(request);
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
      const model = payload?.ai?.modelName || env.GEMINI_MODEL || "gemini-3.5-flash";
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
      const prompt = buildPrompt(payload, fileName, mimeType);

      const geminiResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data: base64 } }
            ]
          }],
          generationConfig: {
            responseMimeType: "application/json"
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

function buildPrompt(payload, fileName, mimeType) {
  const language = payload.language === "zh" ? "Chinese" : "English";
  return `
You are an AI assistant for a tiling contractor estimation prototype.

Analyze the uploaded drawing file and return ONLY valid JSON.
Response language: ${language}.

File:
- name: ${fileName}
- mime type: ${mimeType}

Project:
${JSON.stringify(payload.project || {}, null, 2)}

Site conditions:
${JSON.stringify(payload.site || {}, null, 2)}

Weather context:
${JSON.stringify(payload.weather || {}, null, 2)}

Estimation settings:
${JSON.stringify(payload.settings || {}, null, 2)}

Return this JSON structure:
{
  "summary": "short summary for contractor",
  "rooms": [
    {
      "name": "Living Room",
      "room_type": "Living",
      "shape": "rectangle | l-shape | manual",
      "area": 20.5,
      "gross_area_m2": 20.5,
      "deduction_area_m2": 0,
      "confidence": 0.0,
      "warnings": ["scale unclear"]
    }
  ],
  "drawing_warnings": ["missing scale"],
  "workflow_notes": ["manual review required before ordering"],
  "material_notes": ["increase waste for diagonal or complex layout"],
  "weather_notes": ["outdoor work should be delayed if heavy rain is forecast"]
}

Rules:
- If dimensions are unclear, estimate conservatively and lower confidence.
- Never invent high confidence for unreadable dimensions.
- Flag missing scale, unclear room boundaries, columns, voids, stairs, built-in cabinets, wet areas, and outdoor/weather exposure.
- Keep rooms editable by humans.
`;
}

function normalizeResponse(data, rawText) {
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  return {
    summary: data.summary || "Gemini analysis completed.",
    rooms: rooms.map((room, index) => ({
      name: room.name || room.room_name || `Room ${index + 1}`,
      room_type: room.room_type || room.roomType || "Other",
      shape: room.shape || "manual",
      area: Number(room.area ?? room.gross_area_m2 ?? room.net_area_m2 ?? 0),
      gross_area_m2: Number(room.gross_area_m2 ?? room.area ?? 0),
      deduction_area_m2: Number(room.deduction_area_m2 ?? 0),
      confidence: Number(room.confidence ?? room.confidence_score ?? 0.5),
      warnings: Array.isArray(room.warnings) ? room.warnings : []
    })),
    drawing_warnings: data.drawing_warnings || [],
    workflow_notes: data.workflow_notes || [],
    material_notes: data.material_notes || [],
    weather_notes: data.weather_notes || [],
    raw: rawText
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
  if (/(\.dwg|\.dxf|\.ifc|\.rvt|\.skp)$/.test(lower)) return false;
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

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json;charset=utf-8" }
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
