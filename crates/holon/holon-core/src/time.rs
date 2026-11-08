use sha2::{Digest, Sha256};
use std::fmt::Write;

pub const DAY_MS: i64 = 86_400_000;

pub fn contract_hash(contract: &str) -> String {
    let digest = Sha256::digest(contract.as_bytes());
    let mut out = String::with_capacity(71);
    out.push_str("sha256:");
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

fn digits(bytes: &[u8]) -> Option<i64> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(
        bytes
            .iter()
            .fold(0, |acc, byte| acc * 10 + i64::from(byte - b'0')),
    )
}

fn date_days(bytes: &[u8]) -> Option<i64> {
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year = digits(&bytes[0..4])?;
    let month = digits(&bytes[5..7])?;
    let day = digits(&bytes[8..10])?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

pub fn is_calendar_date(value: &str) -> bool {
    date_days(value.as_bytes()).is_some()
}

fn timestamp_ms(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 17 || bytes[10] != b'T' || bytes[13] != b':' {
        return None;
    }
    let days = date_days(&bytes[0..10])?;
    let hour = digits(&bytes[11..13])?;
    let minute = digits(&bytes[14..16])?;
    let mut rest = &bytes[16..];
    let mut second = 0;
    let mut millis = 0;
    let mut fraction_zero = true;
    if rest.first() == Some(&b':') {
        second = digits(rest.get(1..3)?)?;
        rest = &rest[3..];
        if rest.first() == Some(&b'.') {
            let end = rest[1..]
                .iter()
                .position(|byte| !byte.is_ascii_digit())
                .map_or(rest.len(), |at| at + 1);
            let fraction = &rest[1..end];
            if fraction.is_empty() {
                return None;
            }
            fraction_zero = fraction.iter().all(|byte| *byte == b'0');
            let mut padded = [b'0'; 3];
            for (slot, byte) in padded.iter_mut().zip(fraction.iter()) {
                *slot = *byte;
            }
            millis = digits(&padded)?;
            rest = &rest[end..];
        }
    }
    let offset_minutes = match rest {
        [b'Z'] => 0,
        [sign @ (b'+' | b'-'), h1, h2, b':', m1, m2] => {
            let hours = digits(&[*h1, *h2])?;
            let minutes = digits(&[*m1, *m2])?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            let total = hours * 60 + minutes;
            if *sign == b'+' {
                total
            } else {
                -total
            }
        }
        _ => return None,
    };
    let end_of_day = hour == 24 && minute == 0 && second == 0 && fraction_zero;
    if (hour > 23 && !end_of_day) || minute > 59 || second > 59 {
        return None;
    }
    let ms = days * DAY_MS + ((hour * 60 + minute - offset_minutes) * 60 + second) * 1000 + millis;
    Some(ms)
}

pub fn is_iso_timestamp(value: &str) -> bool {
    timestamp_ms(value).is_some()
}

pub fn parse_instant(value: &str) -> Option<i64> {
    if value.len() == 10 {
        return date_days(value.as_bytes()).map(|days| days * DAY_MS);
    }
    timestamp_ms(value)
}

pub fn format_instant(ms: i64) -> String {
    let days = ms.div_euclid(DAY_MS);
    let in_day = ms.rem_euclid(DAY_MS);
    let (year, month, day) = civil_from_days(days);
    let hour = in_day / 3_600_000;
    let minute = in_day / 60_000 % 60;
    let second = in_day / 1000 % 60;
    let millis = in_day % 1000;
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    if millis == 0 {
        format!("{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
    } else {
        format!("{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
    }
}

pub fn format_date(ms: i64) -> String {
    format_instant(ms).chars().take(10).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_forms_date_parse_accepts() {
        assert_eq!(
            parse_instant("2026-01-01T24:00:00Z"),
            Some(1_767_312_000_000)
        );
        assert_eq!(parse_instant("2026-01-01T24:30Z"), None);
        assert_eq!(
            parse_instant("2026-01-01T00:00:00.9999Z"),
            Some(1_767_225_600_999)
        );
        assert_eq!(
            parse_instant("2026-01-01T00:00:00.1Z"),
            Some(1_767_225_600_100)
        );
        assert_eq!(
            parse_instant("2026-01-01T00:00+23:59"),
            Some(1_767_139_260_000)
        );
        assert_eq!(parse_instant("2026-01-01T00:00+24:00"), None);
        assert_eq!(parse_instant("2026-01-01T00:00:60Z"), None);
        assert_eq!(
            parse_instant("0000-01-01T00:00Z"),
            Some(-62_167_219_200_000)
        );
        assert!(!is_calendar_date("2026-02-30"));
        assert!(is_calendar_date("2024-02-29"));
    }

    #[test]
    fn formats_like_to_iso_string() {
        assert_eq!(format_instant(1_767_225_600_000), "2026-01-01T00:00:00Z");
        assert_eq!(
            format_instant(1_767_225_600_123),
            "2026-01-01T00:00:00.123Z"
        );
        assert_eq!(
            format_instant(-62_167_219_200_001),
            "-000001-12-31T23:59:59.999Z"
        );
        assert_eq!(format_date(1_767_225_600_123), "2026-01-01");
    }

    #[test]
    fn hashes_the_contract() {
        assert_eq!(
            contract_hash(
                "A reset link works once, for 30 minutes, for the address it was sent to."
            ),
            "sha256:caea73569f406ab69441161306067e9f49d0f22f8ec848e7d1c24d3e86f2e23a"
        );
    }
}
