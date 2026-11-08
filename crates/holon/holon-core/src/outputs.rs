use crate::evaluate::{Drift, DriftKind, HolonLight, SideLight, SideView};
use crate::format::Side;
use serde::Serialize;

pub const MAX_CHILDREN: usize = 7;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CheckError {
    pub holon: Option<String>,
    pub file: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CheckWarning {
    pub holon: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CheckOutput {
    pub format: &'static str,
    pub holons: usize,
    pub errors: Vec<CheckError>,
    pub warnings: Vec<CheckWarning>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DriftEntry {
    pub holon: String,
    #[serde(flatten)]
    pub drift: Drift,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftOutput {
    pub format: &'static str,
    pub drift: Vec<DriftEntry>,
    pub computed_at: String,
    pub commit: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSeam {
    pub from: String,
    pub from_title: String,
    pub to: String,
    pub to_title: String,
    pub contract: String,
    pub light: SideLight,
    pub read_only: bool,
    pub exclusive: bool,
    pub drift: Option<DriftKind>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Carrier {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ViewSides {
    #[serde(rename = "I")]
    pub i: SideView,
    #[serde(rename = "It")]
    pub it: SideView,
    #[serde(rename = "We")]
    pub we: SideView,
    #[serde(rename = "They")]
    pub they: SideView,
}

impl ViewSides {
    pub fn get(&self, side: Side) -> &SideView {
        match side {
            Side::I => &self.i,
            Side::It => &self.it,
            Side::We => &self.we,
            Side::They => &self.they,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewFocus {
    pub id: String,
    pub kind: &'static str,
    pub role: &'static str,
    pub title: String,
    pub status: &'static str,
    pub why: String,
    pub contract: String,
    pub carried_by: Vec<Carrier>,
    pub light: HolonLight,
    pub drift: Vec<Drift>,
    pub drift_below: usize,
    pub sides: ViewSides,
    pub code: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewNode {
    pub id: String,
    pub kind: &'static str,
    pub role: &'static str,
    pub title: String,
    pub status: &'static str,
    pub light: HolonLight,
    pub drift_below: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_count: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewOutput {
    pub format: &'static str,
    pub focus: ViewFocus,
    pub parent: Option<ViewNode>,
    pub children: Vec<ViewNode>,
    pub seams: Vec<ViewSeam>,
    pub warnings: Vec<String>,
    pub computed_at: String,
    pub commit: String,
}

pub fn child_warning(id: &str, child_count: usize) -> Option<String> {
    (child_count > MAX_CHILDREN)
        .then(|| format!("{id} has {child_count} children: a level may be missing in between"))
}

pub fn to_json<T: Serialize>(value: &T) -> String {
    let mut text = serde_json::to_string_pretty(value).expect("outputs serialize");
    text.push('\n');
    text
}
