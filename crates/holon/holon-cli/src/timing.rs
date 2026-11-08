use std::sync::{Mutex, OnceLock};
use std::time::Instant;

struct Phases {
    last: Instant,
    marks: Vec<(&'static str, f64)>,
}

fn phases() -> Option<&'static Mutex<Phases>> {
    static PHASES: OnceLock<Option<Mutex<Phases>>> = OnceLock::new();
    PHASES
        .get_or_init(|| {
            std::env::var_os("HOLON_TIMING").map(|_| {
                Mutex::new(Phases {
                    last: Instant::now(),
                    marks: Vec::new(),
                })
            })
        })
        .as_ref()
}

pub fn enabled() -> bool {
    phases().is_some()
}

pub fn start() {
    if let Some(phases) = phases() {
        let mut phases = phases.lock().expect("timing lock");
        phases.last = Instant::now();
        phases.marks.clear();
    }
}

pub fn mark(name: &'static str) {
    if let Some(phases) = phases() {
        let mut phases = phases.lock().expect("timing lock");
        let now = Instant::now();
        let elapsed = now.duration_since(phases.last).as_secs_f64() * 1000.0;
        phases.last = now;
        phases.marks.push((name, elapsed));
    }
}

pub fn summary() -> String {
    phases().map_or_else(String::new, |phases| {
        phases
            .lock()
            .expect("timing lock")
            .marks
            .iter()
            .map(|(name, ms)| format!("{name} {ms:.1}"))
            .collect::<Vec<_>>()
            .join(", ")
    })
}
