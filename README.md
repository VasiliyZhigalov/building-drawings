# Building Drawings

A local toolkit for reconstructing editable building plans and elevations from scans and photographs.

## Components

- `scripts/build_dxf.py` builds DXF drawings from JSON geometry models.
- `scripts/start_review.ps1` starts the local review interface.
- `review-app/` contains the local browser interface for viewing drawings, comparing them with source scans, and saving review notes.
- `skills/building-drawings.zip` is the reusable Codex skill for drawing reconstruction workflows.

The review interface can create a new project brief, save optional building measurements and reconstruction preferences, and copy uploaded source materials into the new project's local `sources/` folder. It preselects the user's usual drawing scope and black linework; building-specific facts stay blank until provided. Project data is intentionally excluded from this public repository.

## Run the review interface

On Windows, run `scripts/start_review.ps1`, then open `http://127.0.0.1:8765`.

The application reads project drawings and reference material from a local `objects/` directory. Project-specific drawings, source scans, photographs, review records, and other object data are intentionally kept out of this public repository.

## DXF builder

Install Python packages `ezdxf` and `shapely`, then run:

```powershell
python scripts/build_dxf.py path/to/model.json --out path/to/output/drawing
```

Model coordinates are in millimeters.
