use std::cmp::Ordering;

pub fn js_cmp(a: &str, b: &str) -> Ordering {
    if a.is_ascii() && b.is_ascii() {
        a.as_bytes().cmp(b.as_bytes())
    } else {
        a.encode_utf16().cmp(b.encode_utf16())
    }
}

pub fn is_js_blank(value: &str) -> bool {
    value.chars().all(|c| {
        matches!(
            c,
            '\u{9}'
                | '\u{a}'
                | '\u{b}'
                | '\u{c}'
                | '\u{d}'
                | ' '
                | '\u{a0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_by_utf16_code_units_like_javascript() {
        assert_eq!(js_cmp("a", "b"), Ordering::Less);
        assert_eq!(js_cmp("\u{ff61}", "\u{1f600}"), Ordering::Greater);
        assert_eq!("\u{ff61}".cmp("\u{1f600}"), Ordering::Less);
    }

    #[test]
    fn treats_blank_like_javascript_trim() {
        assert!(is_js_blank(" \t\u{feff}\u{3000}"));
        assert!(!is_js_blank("\u{85}"));
        assert!(!is_js_blank(" x "));
    }
}
