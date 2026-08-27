use std::io::{self, Read, Write};
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use mlux::compile::FontCache;
use mlux::frame::TiledDocument;
use mlux::pipeline::{BuildParams, build_tiled_document};
use serde::{Deserialize, Serialize};

const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
enum Request {
    Render(RenderRequest),
    Tile { index: usize },
    Shutdown,
}

#[derive(Debug, Serialize, Deserialize)]
struct RenderRequest {
    markdown: String,
    width_px: u32,
    tile_height_px: u32,
    ppi: f32,
    theme: String,
    base_dir: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
enum Response {
    Ready(RenderMeta),
    Tile { index: usize },
    Error { message: String },
    Bye,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderMeta {
    width_px: u32,
    tile_height_px: u32,
    total_height_px: u32,
    tile_count: usize,
    visual_lines: Vec<VisualLineMeta>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VisualLineMeta {
    y_px: u32,
    md_block_range: Option<(usize, usize)>,
    md_offset: Option<usize>,
}

struct RendererState {
    fonts: &'static FontCache,
    document: Option<TiledDocument>,
}

fn main() -> Result<()> {
    let fonts = Box::leak(Box::new(FontCache::new()));
    let mut state = RendererState {
        fonts,
        document: None,
    };
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();

    while let Some((request, _)) = read_frame::<Request>(&mut input)? {
        match request {
            Request::Render(request) => match render_document(&mut state, request) {
                Ok(meta) => write_frame(&mut output, &Response::Ready(meta), &[])?,
                Err(error) => write_frame(
                    &mut output,
                    &Response::Error {
                        message: format!("{error:#}"),
                    },
                    &[],
                )?,
            },
            Request::Tile { index } => match render_tile(&state, index) {
                Ok(png) => write_frame(&mut output, &Response::Tile { index }, &png)?,
                Err(error) => write_frame(
                    &mut output,
                    &Response::Error {
                        message: format!("{error:#}"),
                    },
                    &[],
                )?,
            },
            Request::Shutdown => {
                write_frame(&mut output, &Response::Bye, &[])?;
                return Ok(());
            }
        }
        output.flush().context("flush renderer response")?;
    }

    Ok(())
}

fn render_document(state: &mut RendererState, request: RenderRequest) -> Result<RenderMeta> {
    if request.width_px == 0 || request.tile_height_px == 0 {
        bail!("renderer dimensions must be positive");
    }
    if !request.ppi.is_finite() || request.ppi <= 0.0 {
        bail!("renderer ppi must be positive and finite");
    }
    if request.theme.trim().is_empty() {
        bail!("renderer theme must not be empty");
    }

    let theme_spec = match request.theme.as_str() {
        "catppuccin-mocha" | "dark" => "catppuccin".to_string(),
        "catppuccin-latte" | "light" => "catppuccin-latte".to_string(),
        theme => theme.to_string(),
    };
    let params = BuildParams {
        theme_spec,
        detected_light: false,
        markdown: request.markdown,
        base_dir: request.base_dir.map(PathBuf::from),
        file_path: None,
        width_pt: f64::from(request.width_px) * 72.0 / f64::from(request.ppi),
        // The first vertical slice does not expose mlux's line-number sidebar.
        // Keep a one-point source sidebar so the upstream TiledDocument API can
        // compile unchanged; only content tiles cross the TermLoom protocol.
        sidebar_width_pt: 1.0,
        tile_height_pt: f64::from(request.tile_height_px) * 72.0 / f64::from(request.ppi),
        ppi: request.ppi,
        scale: 1.0,
        fonts: state.fonts,
        allow_remote_images: false,
        fast_png: true,
    };

    let document = build_tiled_document(&params).context("compile Markdown document")?;
    let meta = document.metadata();
    let result = RenderMeta {
        width_px: meta.width_px,
        tile_height_px: meta.tile_height_px,
        total_height_px: meta.total_height_px,
        tile_count: meta.tile_count,
        visual_lines: meta
            .visual_lines
            .iter()
            .map(|line| VisualLineMeta {
                y_px: line.y_px,
                md_block_range: line
                    .md_block_range
                    .as_ref()
                    .map(|range| (range.start, range.end)),
                md_offset: line.md_offset,
            })
            .collect(),
    };
    state.document = Some(document);
    Ok(result)
}

fn render_tile(state: &RendererState, index: usize) -> Result<Vec<u8>> {
    let document = state
        .document
        .as_ref()
        .context("no rendered document; send Render first")?;
    document
        .render_tile(index)
        .with_context(|| format!("render content tile {index}"))
}

fn read_frame<T: for<'de> Deserialize<'de>>(
    reader: &mut impl Read,
) -> Result<Option<(T, Vec<u8>)>> {
    let mut lengths = [0u8; 8];
    match reader.read_exact(&mut lengths) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error).context("read renderer frame lengths"),
    }
    let header_length = u32::from_le_bytes(lengths[0..4].try_into().unwrap()) as usize;
    let payload_length = u32::from_le_bytes(lengths[4..8].try_into().unwrap()) as usize;
    if header_length == 0 || header_length > MAX_FRAME_BYTES {
        bail!("renderer header length {header_length} is outside the allowed range");
    }
    if payload_length > MAX_FRAME_BYTES {
        bail!("renderer payload length {payload_length} is outside the allowed range");
    }
    if header_length.saturating_add(payload_length) > MAX_FRAME_BYTES {
        bail!("renderer frame is outside the allowed size");
    }
    let mut header = vec![0u8; header_length];
    reader
        .read_exact(&mut header)
        .context("read renderer frame header")?;
    let mut payload = vec![0u8; payload_length];
    reader
        .read_exact(&mut payload)
        .context("read renderer frame payload")?;
    serde_json::from_slice(&header)
        .map(|value| Some((value, payload)))
        .context("decode renderer JSON header")
}

fn write_frame<T: Serialize>(writer: &mut impl Write, value: &T, payload: &[u8]) -> Result<()> {
    let header = serde_json::to_vec(value).context("encode renderer JSON header")?;
    if header.is_empty() || header.len() > MAX_FRAME_BYTES {
        bail!("renderer response header is outside the allowed frame size");
    }
    if payload.len() > MAX_FRAME_BYTES
        || header.len().saturating_add(payload.len()) > MAX_FRAME_BYTES
    {
        bail!("renderer response payload is outside the allowed frame size");
    }
    let header_length =
        u32::try_from(header.len()).context("renderer response header is too large")?;
    let payload_length =
        u32::try_from(payload.len()).context("renderer response payload is too large")?;
    writer
        .write_all(&header_length.to_le_bytes())
        .context("write renderer header length")?;
    writer
        .write_all(&payload_length.to_le_bytes())
        .context("write renderer payload length")?;
    writer
        .write_all(&header)
        .context("write renderer frame header")?;
    writer
        .write_all(payload)
        .context("write renderer frame payload")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_round_trips_render_request() {
        let request = Request::Render(RenderRequest {
            markdown: "$E=mc^2$".into(),
            width_px: 640,
            tile_height_px: 720,
            ppi: 144.0,
            theme: "catppuccin-mocha".into(),
            base_dir: None,
        });
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &request, &[]).expect("encode request");
        let (decoded, payload) = read_frame::<Request>(&mut bytes.as_slice())
            .expect("decode request")
            .expect("request exists");
        assert!(matches!(decoded, Request::Render(_)));
        assert!(payload.is_empty());
    }

    #[test]
    fn frame_limit_rejects_oversized_input() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(
            &u32::try_from(MAX_FRAME_BYTES + 1)
                .unwrap()
                .to_le_bytes(),
        );
        let error = read_frame::<Request>(&mut bytes.as_slice()).expect_err("oversized frame");
        assert!(error.to_string().contains("outside the allowed range"));
    }
}
