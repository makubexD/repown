# Renders demo/demo.gif. From the repository root:  vhs demo/demo.tape
# Needs vhs, ttyd and ffmpeg, plus bash, git and node 22.18+ on PATH. Not rendered
# yet: vhs hung on Windows, and on GitHub's Ubuntu 22.04/24.04 runners it produced
# no frames (even for a two-line control tape, with either ffmpeg).

Output demo/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 640
Set Padding 20
Set TypingSpeed 35ms
Set Theme "Dracula"

Hide
Type "source demo/setup.sh" Enter
Sleep 2s
Show

Type "# pin this clone to an account, once" Enter
Type "repown use octocat" Enter
Sleep 2s

Type "repown guard on" Enter
Sleep 1500ms

Type "git commit -qm 'first' --allow-empty" Enter
Sleep 500ms
Type "# a commit made with some other identity (an IDE, a copied config...)" Enter
Type "git -c user.email=someone@example.invalid commit -qm 'oops' --allow-empty" Enter
Sleep 500ms

Type "git push origin main" Enter
Sleep 3s

Type "repown" Enter
Sleep 3500ms

Hide
Type 'export PATH="$ORIGINAL_PATH"; cd / && rm -rf "$DEMO_ROOT"' Enter
