use std::io::{self, Read, Write};

use anyhow::{Context, Result, bail};
use pulldown_latex::{Parser, Storage};
use serde::{Deserialize, Serialize};
use unicode_width::UnicodeWidthStr;

const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
enum Request {
    Layout { source: String, display: bool },
    Shutdown,
}

#[derive(Debug, Serialize)]
enum Response {
    Layout(MathLayout),
    Error { code: String, message: String },
    Bye,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MathLayout {
    lines: Vec<String>,
    width: usize,
    height: usize,
    baseline: usize,
    display: bool,
}

fn main() -> Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();

    while let Some((request, _)) = read_frame::<Request>(&mut input)? {
        let response = match request {
            Request::Layout { source, display } => match layout_math(&source, display) {
                Ok(layout) => Response::Layout(layout),
                Err(error) => Response::Error {
                    code: error.code,
                    message: error.message,
                },
            },
            Request::Shutdown => {
                write_frame(&mut output, &Response::Bye)?;
                output.flush().context("flush math renderer response")?;
                return Ok(());
            }
        };
        write_frame(&mut output, &response)?;
        output.flush().context("flush math renderer response")?;
    }

    Ok(())
}

#[derive(Debug)]
struct LayoutError {
    code: String,
    message: String,
}

fn layout_math(source: &str, display: bool) -> Result<MathLayout, LayoutError> {
    let source = source.replace("\r\n", "\n").replace('\r', "\n");
    let source = source.trim();
    if source.is_empty() {
        return Err(LayoutError {
            code: "empty-formula".into(),
            message: "LaTeX formula is empty".into(),
        });
    }

    validate_latex(source)?;
    let block = term_maths::render(source);
    if block.is_empty() {
        return Err(LayoutError {
            code: "empty-layout".into(),
            message: "LaTeX formula produced an empty cell layout".into(),
        });
    }

    let mut lines = block
        .cells()
        .iter()
        .map(|row| normalize_cells(row))
        .collect::<Vec<_>>();
    if lines.iter().any(|line| contains_tex_control_sequence(line)) {
        return Err(LayoutError {
            code: "unsupported-command".into(),
            message: "LaTeX formula contains a command that term-maths cannot lay out".into(),
        });
    }
    let width = lines
        .iter()
        .map(|line| UnicodeWidthStr::width(line.as_str()))
        .max()
        .unwrap_or(0);
    if width == 0 {
        return Err(LayoutError {
            code: "empty-layout".into(),
            message: "LaTeX formula produced an empty cell layout".into(),
        });
    }
    for line in &mut lines {
        let padding = width.saturating_sub(UnicodeWidthStr::width(line.as_str()));
        line.push_str(&" ".repeat(padding));
    }

    Ok(MathLayout {
        lines,
        width,
        height: block.height(),
        baseline: block.baseline(),
        display,
    })
}

/// Normalize zero-width row markers emitted inside cases delimiter cells.
fn normalize_cells(row: &[String]) -> String {
    let raw = row.iter().map(String::as_str).collect::<String>();
    let mut normalized = String::with_capacity(raw.len());
    for (index, character) in raw.char_indices() {
        if character == '\n' {
            let rest = &raw[index + character.len_utf8()..];
            if rest.trim().is_empty() {
                continue;
            }
            normalized.push(' ');
        } else {
            normalized.push(character);
        }
    }
    normalized
}

fn validate_latex(source: &str) -> Result<(), LayoutError> {
    let mut storage = Storage::new();
    let parser = Parser::new(source, &storage);
    if let Err(error) = parser.collect::<std::result::Result<Vec<_>, _>>() {
        return Err(LayoutError {
            code: "parse-error".into(),
            message: format!("LaTeX parse error: {error}"),
        });
    }
    storage.reset();
    Ok(())
}

fn contains_tex_control_sequence(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            index += 1;
            continue;
        }
        let mut next = index + 1;
        while next < bytes.len() && bytes[next].is_ascii_alphabetic() {
            next += 1;
        }
        if next > index + 1 {
            return true;
        }
        index = next;
    }
    false
}

fn read_frame<T: for<'de> Deserialize<'de>>(
    reader: &mut impl Read,
) -> Result<Option<(T, Vec<u8>)>> {
    let mut lengths = [0u8; 8];
    match reader.read_exact(&mut lengths) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error).context("read math renderer frame lengths"),
    }
    let header_length = u32::from_le_bytes(lengths[0..4].try_into().unwrap()) as usize;
    let payload_length = u32::from_le_bytes(lengths[4..8].try_into().unwrap()) as usize;
    if header_length == 0 || header_length > MAX_FRAME_BYTES {
        bail!("math renderer header length {header_length} is outside the allowed range");
    }
    if payload_length > MAX_FRAME_BYTES
        || header_length.saturating_add(payload_length) > MAX_FRAME_BYTES
    {
        bail!("math renderer frame is outside the allowed size");
    }
    let mut header = vec![0u8; header_length];
    reader
        .read_exact(&mut header)
        .context("read math renderer frame header")?;
    let mut payload = vec![0u8; payload_length];
    reader
        .read_exact(&mut payload)
        .context("read math renderer frame payload")?;
    serde_json::from_slice(&header)
        .map(|value| Some((value, payload)))
        .context("decode math renderer JSON header")
}

fn write_frame<T: Serialize>(writer: &mut impl Write, value: &T) -> Result<()> {
    let header = serde_json::to_vec(value).context("encode math renderer JSON header")?;
    if header.is_empty() || header.len() > MAX_FRAME_BYTES {
        bail!("math renderer response header is outside the allowed frame size");
    }
    let header_length = u32::try_from(header.len()).context("math renderer header is too large")?;
    writer
        .write_all(&header_length.to_le_bytes())
        .context("write math renderer header length")?;
    writer
        .write_all(&0u32.to_le_bytes())
        .context("write math renderer payload length")?;
    writer
        .write_all(&header)
        .context("write math renderer response")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_fraction_as_a_two_dimensional_cell_block() {
        let layout = layout_math(r"\frac{a+b}{c}", true).expect("fraction layout");
        assert!(layout.height >= 3);
        assert!(layout.lines.iter().any(|line| line.contains('─')));
        assert_eq!(layout.display, true);
    }

    #[test]
    fn rejects_unknown_commands_instead_of_returning_text() {
        let error = layout_math(r"\totallyUnknown{x}", false).expect_err("unknown command");
        assert!(error.code == "parse-error" || error.code == "unsupported-command");
    }

    #[test]
    fn rejects_empty_input() {
        let error = layout_math("  ", false).expect_err("empty formula");
        assert_eq!(error.code, "empty-formula");
    }

    #[test]
    fn accepts_common_markdown_latex_corpus() {
        let corpus = [
            (r"e^{i\pi}+1=0", false),
            (r"x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}", true),
            (r"\int_0^1 x^2\,dx=\frac{1}{3}", true),
            (r"\begin{cases}x&x>0\\-x&x\le 0\end{cases}", true),
            (r"\begin{bmatrix}a&b\\c&d\end{bmatrix}", true),
            (r"\mathbb{R}\subset\mathbb{C}", false),
        ];
        for (source, display) in corpus {
            let layout = layout_math(source, display).expect(source);
            assert!(!layout.lines.is_empty(), "{source}");
            assert!(layout.width > 0, "{source}");
            assert_eq!(layout.height, layout.lines.len(), "{source}");
        }
    }

    #[test]
    fn keeps_cases_rows_as_single_character_cell_lines() {
        let layout =
            layout_math(r"\begin{cases}x&x>0\\-x&x\le 0\end{cases}", true).expect("cases layout");
        assert_eq!(layout.height, 2);
        assert!(layout.lines.iter().all(|line| !line.contains('\n')));
        assert!(layout
            .lines
            .iter()
            .all(|line| UnicodeWidthStr::width(line.as_str()) <= layout.width));
    }

    #[test]
    fn keeps_simultaneous_scripts_on_separate_rows() {
        let layout = layout_math(r"x_i^2", false).expect("superscript and subscript");
        assert_eq!(layout.height, 3);
        assert!(layout.lines[0].contains('2'));
        assert!(layout.lines[1].contains('𝑥'));
        assert!(layout.lines[2].contains('𝑖'));
    }

    #[test]
    fn joins_radical_vinculum_to_the_radical_stem() {
        let layout = layout_math(r"\sqrt{b^2-4ac}", true).expect("radical layout");
        assert!(layout.lines[0].starts_with('╱'));
        assert!(layout.lines.iter().any(|line| line.contains('√')));
    }

    #[test]
    fn inserts_math_operator_spacing() {
        let layout = layout_math(r"\sin x", false).expect("operator layout");
        assert!(layout.lines[0].contains("sin "));
    }

    #[test]
    fn rejects_malformed_latex_without_text_fallback() {
        for source in [r"\frac{a}{b", r"\begin{matrix}a&b\end{cases}"] {
            let error = layout_math(source, false).expect_err(source);
            assert_eq!(error.code, "parse-error", "{source}");
        }
    }
}
