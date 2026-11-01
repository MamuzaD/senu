-- senu: add these lines to your init.lua, then reload it. Paths assume
-- install.sh's default ~/.local/bin; change them if you set SENU_INSTALL_DIR.

local home = os.getenv("HOME")

local function popup(name, title, w, h, command)
	rex.action({
		name = name,
		title = title,
		category = "Popups",
		run = function()
			rex.session.new_layer({
				bounds = { (1 - w) / 2, (1 - h) / 2, w, h },
				focus = true,
				layout = rex.layout.block({
					flavor = "com.superlogical.terminal.shell",
					label = title,
					options = { command = command },
				}),
			})
		end,
	})
end

-- Pick an agent and jump to it, and usage limits and cost. Bind these with
-- rex.bind to whichever keys you like.
popup("senu_threads", "Senu Threads", 0.65, 0.6, { home .. "/.local/bin/senu", "threads", "--live" })
popup("senu_vision", "Senu Vision", 0.65, 0.7, { home .. "/.local/bin/senu", "vision" })
