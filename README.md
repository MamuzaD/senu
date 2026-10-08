# senu

### AI agent dashboard for the terminal

<img width="1280" height="580" alt="senu-keep-watch-no-top-band" src="https://github.com/user-attachments/assets/64b599a8-1b6f-4a70-8333-700c93e8a144" />

## Built With

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=fff)
![Bun](https://img.shields.io/badge/Bun-000?style=for-the-badge&logo=bun&logoColor=fff)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![OpenTUI](https://img.shields.io/badge/OpenTUI-000?style=for-the-badge)

## Features

- Monitor Claude Code and Codex panes across tmux sessions
- See whether agents are working, blocked, idle, or finished
- Get an alert when a background agent finishes or needs input
- Browse agent windows and jump straight to one
- Inspect agent detection rules and refresh [herdr](https://github.com/herdrdev/herdr)'s detection manifests

## Installation

```sh
curl -fsSL https://raw.githubusercontent.com/MamuzaD/senu/main/install.sh | sh
```

`senu` lands in `~/.local/bin`, so keep that on your `PATH`. Re-run the script to update;
`senu --version` shows the installed version. Requires tmux on macOS or Linux.

Add the lines from [`tmux.example.conf`](tmux.example.conf) to your tmux.conf, then reload tmux
(`tmux source-file <your tmux.conf>`); `senu watch once` shows what it sees.

Configuration lives at `~/.config/senu/config.toml`; see [`config.example.toml`](config.example.toml).

<details>
<summary>Other ways to install</summary>

### Build from Source

```sh
git clone https://github.com/MamuzaD/senu.git
cd senu
bun install
bun run build
./dist/senu --help
```

Run `bun test` and `bun run typecheck` to check changes, or `bun run dev` to run from source.

### Install from releases

[Grab a build for your machine here](https://github.com/MamuzaD/senu/releases). On macOS, a
browser download needs `xattr -d com.apple.quarantine senu && chmod +x senu` first.

</details>
