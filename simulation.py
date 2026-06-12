"""
Synthetic comparison for the thesis prototype.

Purpose:
Compare AI-assisted and conventional tiling estimation across many sample
projects before or alongside a small real-user test.

Run:
python simulation.py --samples 100 --seed 42
"""

from __future__ import annotations

import argparse
import csv
import json
import random
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass
class Project:
    project_id: int
    floor_area_m2: float
    room_count: int
    complexity: str
    drawing_quality: str
    tile_pattern: str
    actual_material_cost: float
    actual_duration_days: float


@dataclass
class Result:
    project_id: int
    method: str
    estimated_material_cost: float
    material_error_percent: float
    estimated_duration_days: float
    duration_error_percent: float
    preparation_minutes: float


def clamp(value: float, minimum: float = 0.0) -> float:
    return max(minimum, value)


def error_band(method: str, project: Project) -> tuple[float, float, float]:
    if method == "ai":
        base_material_error = 0.08
        base_duration_error = 0.10
        time_mean = 6.0
    else:
        base_material_error = 0.15
        base_duration_error = 0.18
        time_mean = 55.0

    complexity_penalty = {"simple": 0.00, "moderate": 0.03, "complex": 0.07}[project.complexity]
    quality_penalty = {"clean": 0.00, "mixed": 0.03, "poor": 0.08}[project.drawing_quality]
    pattern_penalty = {"straight": 0.00, "diagonal": 0.03, "intricate": 0.06}[project.tile_pattern]

    if method == "ai":
        material_error = base_material_error + complexity_penalty * 0.8 + quality_penalty + pattern_penalty * 0.8
        duration_error = base_duration_error + complexity_penalty + quality_penalty * 0.6 + pattern_penalty * 0.6
    else:
        material_error = base_material_error + complexity_penalty + quality_penalty * 0.5 + pattern_penalty
        duration_error = base_duration_error + complexity_penalty + pattern_penalty + quality_penalty * 0.4

    return material_error, duration_error, time_mean


def create_project(project_id: int) -> Project:
    floor_area = random.uniform(18, 120)
    room_count = random.randint(1, 8)
    complexity = random.choices(["simple", "moderate", "complex"], weights=[0.35, 0.45, 0.20])[0]
    drawing_quality = random.choices(["clean", "mixed", "poor"], weights=[0.35, 0.45, 0.20])[0]
    tile_pattern = random.choices(["straight", "diagonal", "intricate"], weights=[0.65, 0.25, 0.10])[0]

    material_rate = random.uniform(48, 78)
    actual_material_cost = floor_area * material_rate
    daily_output = random.uniform(28, 48)
    actual_duration = floor_area / daily_output
    if complexity == "complex":
        actual_duration *= 1.25
    if tile_pattern == "intricate":
        actual_duration *= 1.18

    return Project(
        project_id=project_id,
        floor_area_m2=round(floor_area, 2),
        room_count=room_count,
        complexity=complexity,
        drawing_quality=drawing_quality,
        tile_pattern=tile_pattern,
        actual_material_cost=round(actual_material_cost, 2),
        actual_duration_days=round(actual_duration, 2),
    )


def estimate(project: Project, method: str) -> Result:
    material_error_mean, duration_error_mean, time_mean = error_band(method, project)
    material_error = clamp(random.gauss(material_error_mean, material_error_mean * 0.35))
    duration_error = clamp(random.gauss(duration_error_mean, duration_error_mean * 0.35))
    material_direction = random.choice([-1, 1])
    duration_direction = random.choice([-1, 1])

    estimated_material = project.actual_material_cost * (1 + material_direction * material_error)
    estimated_duration = project.actual_duration_days * (1 + duration_direction * duration_error)
    preparation_minutes = clamp(random.gauss(time_mean, time_mean * 0.20), 0.5)

    return Result(
        project_id=project.project_id,
        method=method,
        estimated_material_cost=round(estimated_material, 2),
        material_error_percent=round(material_error * 100, 2),
        estimated_duration_days=round(estimated_duration, 2),
        duration_error_percent=round(duration_error * 100, 2),
        preparation_minutes=round(preparation_minutes, 2),
    )


def summarize(results: list[Result]) -> dict[str, float]:
    by_method = {"ai": [], "conventional": []}
    for result in results:
        by_method[result.method].append(result)

    def avg(method: str, field: str) -> float:
        values = [getattr(row, field) for row in by_method[method]]
        return round(sum(values) / len(values), 2) if values else 0.0

    ai_time = avg("ai", "preparation_minutes")
    conventional_time = avg("conventional", "preparation_minutes")
    time_saving = (conventional_time - ai_time) / conventional_time * 100 if conventional_time else 0

    return {
        "ai_material_error_percent": avg("ai", "material_error_percent"),
        "conventional_material_error_percent": avg("conventional", "material_error_percent"),
        "ai_duration_error_percent": avg("ai", "duration_error_percent"),
        "conventional_duration_error_percent": avg("conventional", "duration_error_percent"),
        "ai_preparation_minutes": ai_time,
        "conventional_preparation_minutes": conventional_time,
        "time_saving_percent": round(time_saving, 2),
    }


def write_outputs(projects: list[Project], results: list[Result], summary: dict[str, float], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "sample_projects.json").open("w", encoding="utf-8") as file:
        json.dump([asdict(project) for project in projects], file, indent=2)

    with (out_dir / "simulation_results.csv").open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=list(asdict(results[0]).keys()))
        writer.writeheader()
        for row in results:
            writer.writerow(asdict(row))

    with (out_dir / "simulation_summary.json").open("w", encoding="utf-8") as file:
        json.dump(summary, file, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=int, default=100)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", default="simulation_output")
    args = parser.parse_args()

    random.seed(args.seed)
    projects = [create_project(index + 1) for index in range(args.samples)]
    results: list[Result] = []
    for project in projects:
        results.append(estimate(project, "ai"))
        results.append(estimate(project, "conventional"))

    summary = summarize(results)
    write_outputs(projects, results, summary, Path(args.out))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
