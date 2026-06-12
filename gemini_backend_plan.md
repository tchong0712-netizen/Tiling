# Gemini Backend Plan

## Target

Build a backend that lets a small tiling contractor upload a drawing and receive:

- detected rooms and uncertain dimensions
- editable quantity take-off JSON
- tile, adhesive, grout, cement, sand, and waste estimates
- labour duration and risk-adjusted workflow plan
- comparison data for AI-assisted vs conventional methods

## Why Gemini

Gemini is the first target because the Gemini Developer API provides a free tier for small projects and supports multimodal inputs. The API key should stay on the backend, not inside `index.html`.

## Input Handling

| Input | Backend action | Gemini action |
| --- | --- | --- |
| PDF drawing | upload through Files API | document processing |
| PNG/JPEG/WEBP/HEIC/HEIF | pass as image input | image understanding |
| DWG/DXF/IFC/RVT/SKP | convert to PDF or high-resolution PNG first | analyze converted file |
| Excel/CSV | parse as conventional baseline | optional LLM explanation |
| poor scan/photo | clean/deskew/crop first | ask model to return uncertainty flags |

## Proposed API

`POST /api/projects`

Create a project case.

`POST /api/uploads`

Upload drawing files. Store original file and generated previews.

`POST /api/analyze/gemini`

Send PDF/image or converted CAD preview to Gemini. Return structured JSON:

```json
{
  "rooms": [
    {
      "name": "Living Room",
      "room_type": "Living",
      "shape": "rectangle",
      "gross_area_m2": 20.8,
      "deduction_area_m2": 0.35,
      "confidence": 0.86,
      "warnings": ["dimension text partly unclear"]
    }
  ],
  "drawing_warnings": ["scale needs confirmation"],
  "workflow_notes": ["manual review required before ordering"]
}
```

`POST /api/estimate`

Run deterministic material and duration formulas after human review.

`POST /api/simulation/run`

Run Python simulation for sample projects.

## Research Design

Use two evidence streams:

- small real-user test: Malaysian tiling contractors or estimators complete the same task using conventional and AI-assisted workflows
- large simulation: Python-generated sample projects compare expected error, time saving, and method robustness under different drawing complexity levels

## Safety

- Keep Gemini API key in environment variables only.
- Store uploaded files temporarily where possible.
- Show confidence and warning flags instead of presenting AI output as final truth.
- Require human review for low-confidence rooms, missing scale, unclear dimensions, wet areas, diagonal layout, and occupied renovation constraints.
