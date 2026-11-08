use holon_core::evaluate::SideLight;
use holon_core::format::Side;
use holon_core::outputs::{CheckOutput, DriftOutput, ViewOutput};

fn plural(count: usize, word: &str) -> String {
    format!("{count} {word}{}", if count == 1 { "" } else { "s" })
}

fn finish(lines: Vec<String>) -> String {
    let mut text = lines.join("\n");
    text.push('\n');
    text
}

pub fn render_check(output: &CheckOutput) -> String {
    let mark = if output.errors.is_empty() {
        "●"
    } else {
        "✕"
    };
    let mut lines = vec![format!(
        "{mark} {}, {}, {}",
        plural(output.holons, "holon"),
        plural(output.errors.len(), "error"),
        plural(output.warnings.len(), "warning")
    )];
    for error in &output.errors {
        let holon = error
            .holon
            .as_ref()
            .map_or_else(String::new, |holon| format!(" ({holon})"));
        lines.push(format!("✕ {}{holon}: {}", error.file, error.message));
    }
    for warning in &output.warnings {
        lines.push(format!("! {}: {}", warning.holon, warning.message));
    }
    finish(lines)
}

pub fn render_drift(output: &DriftOutput) -> String {
    if output.drift.is_empty() {
        return format!(
            "● no drift at {}, commit {}\n",
            output.computed_at, output.commit
        );
    }
    let mut lines = vec![format!(
        "◇ {} at {}, commit {}",
        plural(output.drift.len(), "drift"),
        output.computed_at,
        output.commit
    )];
    for item in &output.drift {
        let drift = &item.drift;
        let place = match (drift.side, &drift.seam) {
            (Some(side), _) => format!("  {}", side.as_str()),
            (None, Some(seam)) => format!("  seam {seam}"),
            (None, None) => String::new(),
        };
        lines.push(format!(
            "◇ {}  {}{place}  {}",
            item.holon,
            drift.kind.as_str(),
            drift.detail
        ));
    }
    finish(lines)
}

fn light_name(light: SideLight) -> &'static str {
    light.as_str()
}

pub fn render_view(view: &ViewOutput) -> String {
    let focus = &view.focus;
    let below = if focus.drift_below > 0 {
        format!("  ◇ {} below", focus.drift_below)
    } else {
        String::new()
    };
    let carriers: Vec<&str> = focus
        .carried_by
        .iter()
        .map(|item| item.title.as_str())
        .collect();
    let mut lines = vec![
        format!(
            "{} {} ({}, {}, {}){below}",
            focus.light.glyph(),
            focus.title,
            focus.id,
            focus.kind,
            focus.status
        ),
        format!(
            "  Why: {}",
            if focus.why.is_empty() {
                "(none)"
            } else {
                &focus.why
            }
        ),
        format!("  Contract: {}", focus.contract),
        format!(
            "  Carried by: {}",
            if carriers.is_empty() {
                "(nobody)".to_string()
            } else {
                carriers.join(", ")
            }
        ),
    ];
    for side in Side::ALL {
        let item = focus.sides.get(side);
        let source = match (item.kind, &item.source) {
            (None, _) => String::new(),
            (Some(kind), None) => format!(" {kind}"),
            (Some(kind), Some(source)) => format!(" {kind} {source}"),
        };
        lines.push(format!(
            "  {:<4} {} {}{source}: {}",
            side.as_str(),
            item.light.glyph(),
            light_name(item.light),
            item.detail
        ));
    }
    for item in &focus.drift {
        let side = item
            .side
            .map_or_else(String::new, |side| format!(" {}", side.as_str()));
        let seam = item
            .seam
            .as_ref()
            .map_or_else(String::new, |seam| format!(" seam {seam}"));
        lines.push(format!(
            "  ◇ {}{side}{seam}: {}",
            item.kind.as_str(),
            item.detail
        ));
    }
    if let Some(parent) = &view.parent {
        lines.push(format!(
            "Part of: {} {} ({})",
            parent.light.glyph(),
            parent.title,
            parent.id
        ));
    }
    if !view.children.is_empty() {
        lines.push("Parts:".to_string());
        for child in &view.children {
            let below = if child.drift_below > 0 {
                format!("  ◇ {}", child.drift_below)
            } else {
                String::new()
            };
            lines.push(format!(
                "  {} {} ({}){below}",
                child.light.glyph(),
                child.title,
                child.id
            ));
        }
    }
    if !view.seams.is_empty() {
        lines.push("Seams:".to_string());
        for seam in &view.seams {
            let marks: Vec<&str> = [
                seam.read_only.then_some("read-only"),
                seam.exclusive.then_some("exclusive"),
                seam.drift.map(|kind| kind.as_str()),
            ]
            .into_iter()
            .flatten()
            .collect();
            let marks = if marks.is_empty() {
                String::new()
            } else {
                format!(" [{}]", marks.join(", "))
            };
            lines.push(format!(
                "  {} {} → {}: {}{marks}",
                seam.light.glyph(),
                seam.from,
                seam.to,
                seam.contract
            ));
        }
    }
    for warning in &view.warnings {
        lines.push(format!("! {warning}"));
    }
    lines.push(format!(
        "computed at {}, commit {}",
        view.computed_at, view.commit
    ));
    finish(lines)
}
