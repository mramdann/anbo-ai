use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ancestors {
    Levels(u32),
    Row,
}

impl Ancestors {
    pub fn parse(value: Option<&Value>) -> Result<Self, (String, String)> {
        match value {
            None => Ok(Self::Levels(0)),
            Some(Value::String(mode)) if mode == "row" => Ok(Self::Row),
            Some(value) if value.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0) => {
                Ok(Self::Levels(value.as_f64().unwrap().min(10.0) as u32))
            }
            _ => Err((
                "invalid_request".into(),
                "ancestors must be a non-negative number or 'row'".into(),
            )),
        }
    }

    pub fn value(self) -> Value {
        match self {
            Self::Levels(n) => json!(n.min(10)),
            Self::Row => json!("row"),
        }
    }
}

pub const CONTEXT_BLOCK_JS: &str = include_str!("contextBlock.js");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_bounded_levels_or_explicit_row_and_rejects_guesses() {
        for (input, output) in [
            (json!(0), json!(0)),
            (json!(2.9), json!(2)),
            (json!(99), json!(10)),
            (json!("row"), json!("row")),
        ] {
            assert_eq!(Ancestors::parse(Some(&input)).unwrap().value(), output);
        }
        for input in [
            json!("card"),
            json!("2"),
            json!(-1),
            json!(null),
            json!(true),
            json!({}),
        ] {
            assert!(Ancestors::parse(Some(&input)).is_err());
        }
        assert_eq!(Ancestors::parse(None).unwrap(), Ancestors::Levels(0));
    }
}
