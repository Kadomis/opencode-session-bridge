use session_bridge_core::{handle_request, CoreState};
use std::io::{self, BufRead, Write};

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut state = CoreState::default();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = handle_request(&line, &mut state);
        writeln!(stdout, "{response}")?;
        stdout.flush()?;
    }
    Ok(())
}
