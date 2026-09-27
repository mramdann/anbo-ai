use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const TO_BROWSER_LIMIT: usize = 1024 * 1024;
pub const FROM_BROWSER_LIMIT: usize = 16 * 1024 * 1024;

pub async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> Result<Option<Vec<u8>>, String> {
    let mut header = [0_u8; 4];
    if reader
        .read(&mut header[..1])
        .await
        .map_err(|error| error.to_string())?
        == 0
    {
        return Ok(None);
    }
    reader
        .read_exact(&mut header[1..])
        .await
        .map_err(|error| error.to_string())?;
    let length = u32::from_ne_bytes(header) as usize;
    if length == 0 || length > limit {
        return Err("browser bridge frame exceeds its size limit".into());
    }
    let mut body = vec![0; length];
    reader
        .read_exact(&mut body)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Some(body))
}

pub async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    body: &[u8],
    limit: usize,
) -> Result<(), String> {
    if body.is_empty() || body.len() > limit || body.len() > u32::MAX as usize {
        return Err("browser bridge frame exceeds its size limit".into());
    }
    writer
        .write_all(&(body.len() as u32).to_ne_bytes())
        .await
        .map_err(|error| error.to_string())?;
    writer
        .write_all(body)
        .await
        .map_err(|error| error.to_string())?;
    writer.flush().await.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn framing_round_trips_and_distinguishes_eof_from_truncation() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, br#"{"ok":true}"#, TO_BROWSER_LIMIT)
            .await
            .unwrap();
        let mut reader = bytes.as_slice();
        assert_eq!(
            read_frame(&mut reader, FROM_BROWSER_LIMIT).await.unwrap(),
            Some(br#"{"ok":true}"#.to_vec())
        );
        assert!(read_frame(&mut reader, FROM_BROWSER_LIMIT)
            .await
            .unwrap()
            .is_none());
        assert!(read_frame(&mut &[2_u8][..], FROM_BROWSER_LIMIT)
            .await
            .is_err());
        assert!(read_frame(&mut &[2, 0, 0, 0, 1][..], FROM_BROWSER_LIMIT)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn rejects_oversized_frames_before_reading_or_writing_the_body() {
        let header = ((FROM_BROWSER_LIMIT + 1) as u32).to_ne_bytes();
        assert!(read_frame(&mut header.as_slice(), FROM_BROWSER_LIMIT)
            .await
            .is_err());
        let mut output = Vec::new();
        assert!(write_frame(&mut output, b"oversized", 2).await.is_err());
        assert!(output.is_empty());
        assert!(read_frame(&mut &[0_u8; 4][..], FROM_BROWSER_LIMIT)
            .await
            .is_err());
    }
}
