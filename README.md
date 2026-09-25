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
- Inspect agent detection rules and refresh detection manifests

## Development

```sh
bun install
bun run dev
bun run build  # single binary at dist/senu
```

Configuration lives at `~/.config/senu/config.toml`; see [`config.example.toml`](config.example.toml).
