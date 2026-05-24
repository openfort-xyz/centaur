"""CLI for Telegram bot operations."""

import asyncio
import json

from dotenv import load_dotenv

load_dotenv()

import typer
from rich.console import Console

from centaur_sdk import Table

app = typer.Typer(name="telegram", help="Telegram CLI for AI agents")
console = Console()


@app.command()
def send(
    chat_id: str = typer.Argument(..., help="Chat ID or @username"),
    message: str = typer.Argument(..., help="Message text to send"),
    markdown: bool = typer.Option(False, "--markdown", "-m", help="Parse as Markdown"),
    html: bool = typer.Option(False, "--html", help="Parse as HTML"),
    reply_to: int = typer.Option(None, "--reply-to", "-r", help="Message ID to reply to"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Send a message to a chat or user."""
    from .client import TelegramClient

    parse_mode = None
    if markdown:
        parse_mode = "Markdown"
    elif html:
        parse_mode = "HTML"

    client = TelegramClient()
    result = asyncio.run(
        client.send_message(
            chat_id=chat_id,
            text=message,
            parse_mode=parse_mode,
            reply_to_message_id=reply_to,
        )
    )

    if json_output:
        print(json.dumps(result, indent=2))
    else:
        console.print(f"[green]✓[/] Sent to [cyan]{result['chat_title'] or result['chat_id']}[/]")
        console.print(f"  Message ID: {result['message_id']}")


@app.command()
def updates(
    limit: int = typer.Option(20, "--limit", "-n", help="Max updates to fetch"),
    full: bool = typer.Option(False, "--full", "-f", help="Show full message text"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
    watch: bool = typer.Option(
        False, "--watch", "-w", help="Watch for new messages (long polling)"
    ),
):
    """Get recent messages sent to the bot."""
    from .client import TelegramClient

    client = TelegramClient()

    if json_output and not watch:
        results = asyncio.run(client.get_updates(limit=limit))
        print(json.dumps(results, indent=2))
        return

    async def poll():
        offset = None
        while True:
            msgs = await client.get_updates(
                limit=limit if offset is None else 10,
                timeout=5 if watch else 0,
                offset=offset,
            )

            for msg in msgs:
                offset = msg["update_id"] + 1
                user = f"@{msg['from_user']}" if msg["from_user"] else f"id:{msg['from_id']}"
                chat = msg["chat_title"] or f"id:{msg['chat_id']}"

                if full:
                    console.print(f"\n[cyan]{chat}[/] | [green]{user}[/] | {msg['date']}")
                    console.print(msg["text"])
                else:
                    text = (msg["text"] or "")[:80].replace("\n", " ")
                    if len(msg["text"] or "") > 80:
                        text += "..."
                    console.print(f"[cyan]{chat}[/] [green]{user}[/]: {text}")

            if not watch:
                break

    try:
        asyncio.run(poll())
    except KeyboardInterrupt:
        console.print("\n[yellow]Stopped watching.[/]")


@app.command()
def chat(
    chat_id: str = typer.Argument(..., help="Chat ID or @username"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Get info about a chat, group, or channel."""
    from .client import TelegramClient

    client = TelegramClient()
    result = asyncio.run(client.get_chat(chat_id=chat_id))

    if json_output:
        print(json.dumps(result, indent=2))
    else:
        table = Table(title=f"Chat: {result.get('title') or result.get('username') or chat_id}")
        table.add_column("Property", style="cyan")
        table.add_column("Value", style="white")

        table.add_row("ID", str(result["id"]))
        table.add_row("Type", result["type"])
        if result.get("title"):
            table.add_row("Title", result["title"])
        if result.get("username"):
            table.add_row("Username", f"@{result['username']}")
        if result.get("description"):
            table.add_row("Description", result["description"][:100])
        if result.get("member_count"):
            table.add_row("Members", str(result["member_count"]))

        console.print(table)


@app.command()
def me(
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Get info about the bot."""
    from .client import TelegramClient

    client = TelegramClient()
    result = asyncio.run(client.get_me())

    if json_output:
        print(json.dumps(result, indent=2))
    else:
        console.print(f"[bold]Bot:[/] @{result['username']} ({result['first_name']})")
        console.print(f"[dim]ID: {result['id']}[/]")
        console.print(f"Can join groups: {result['can_join_groups']}")
        console.print(f"Can read group messages: {result['can_read_all_group_messages']}")


@app.command()
def forward(
    to_chat: str = typer.Argument(..., help="Destination chat ID or @username"),
    from_chat: str = typer.Argument(..., help="Source chat ID"),
    message_id: int = typer.Argument(..., help="Message ID to forward"),
):
    """Forward a message to another chat."""
    from .client import TelegramClient

    client = TelegramClient()
    result = asyncio.run(
        client.forward_message(
            chat_id=to_chat,
            from_chat_id=from_chat,
            message_id=message_id,
        )
    )

    console.print(f"[green]✓[/] Forwarded as message {result['message_id']}")


@app.command()
def delete(
    chat_id: str = typer.Argument(..., help="Chat ID"),
    message_id: int = typer.Argument(..., help="Message ID to delete"),
):
    """Delete a message."""
    from .client import TelegramClient

    client = TelegramClient()
    asyncio.run(client.delete_message(chat_id=chat_id, message_id=message_id))
    console.print(f"[green]✓[/] Deleted message {message_id}")


@app.command()
def webhook(
    url: str = typer.Argument(None, help="Webhook URL to set (omit to show status)"),
    delete_hook: bool = typer.Option(False, "--delete", "-d", help="Delete current webhook"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Manage webhook for receiving updates."""
    from .client import TelegramClient

    client = TelegramClient()

    if delete_hook:
        asyncio.run(client.delete_webhook())
        console.print("[green]✓[/] Webhook deleted. Bot will use polling.")
        return

    if url:
        asyncio.run(client.set_webhook(url))
        console.print(f"[green]✓[/] Webhook set to: {url}")
        return

    info = asyncio.run(client.get_webhook_info())

    if json_output:
        print(json.dumps(info, indent=2))
    else:
        if info["url"]:
            console.print(f"[bold]Webhook URL:[/] {info['url']}")
            console.print(f"Pending updates: {info['pending_update_count']}")
            if info["last_error_message"]:
                console.print(f"[red]Last error:[/] {info['last_error_message']}")
        else:
            console.print("[dim]No webhook configured. Using polling.[/]")


@app.command()
def login(
    phone: str = typer.Argument(..., help="Phone number with country code (e.g., +1234567890)"),
):
    """Login with your Telegram account (MTProto)."""
    from .user_client import UserClient

    client = UserClient()

    console.print(f"[dim]Sending code to {phone}...[/]")
    result = asyncio.run(client.login(phone))

    if result["status"] != "code_sent":
        console.print(f"[red]Unexpected status: {result}[/]")
        raise typer.Exit(1)

    code = typer.prompt("Enter the code sent to your Telegram")

    verify_result = asyncio.run(
        client.verify_code(
            phone=result["phone"],
            code=code,
            phone_code_hash=result["phone_code_hash"],
        )
    )

    if verify_result.get("status") == "2fa_required":
        password = typer.prompt("Enter your 2FA password", hide_input=True)
        verify_result = asyncio.run(client.verify_2fa(password))

    if verify_result.get("status") == "logged_in":
        console.print(
            f"[green]✓[/] Logged in as @{verify_result.get('username')} ({verify_result.get('first_name')})"
        )
    else:
        console.print(f"[red]Login failed: {verify_result}[/]")
        raise typer.Exit(1)


@app.command()
def history(
    entity: str = typer.Argument(..., help="Chat/channel username or ID"),
    limit: int = typer.Option(50, "--limit", "-n", help="Max messages to fetch"),
    search: str = typer.Option(None, "--search", "-s", help="Search query"),
    full: bool = typer.Option(False, "--full", "-f", help="Show full message text"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Get message history from a chat/channel (requires login)."""
    from .user_client import UserClient

    client = UserClient()

    try:
        messages = asyncio.run(
            client.get_messages(
                entity=entity,
                limit=limit,
                search=search,
            )
        )
    finally:
        asyncio.run(client.disconnect())

    if json_output:
        print(json.dumps(messages, indent=2, ensure_ascii=False))
        return

    if not messages:
        console.print("[yellow]No messages found.[/]")
        raise typer.Exit()

    console.print(f"[bold]{entity}[/] - {len(messages)} messages\n")

    for msg in reversed(messages):
        sender = msg["sender_name"] or f"id:{msg['sender_id']}"
        text = msg["text"] or "[no text]"

        if not full and len(text) > 150:
            text = text[:150].replace("\n", " ") + "..."
        elif not full:
            text = text.replace("\n", " ")

        date = msg["date"][:10] if msg["date"] else ""
        console.print(f"[dim]{date}[/] [green]{sender}[/]: {text}")


@app.command()
def dialogs(
    limit: int = typer.Option(50, "--limit", "-n", help="Max dialogs to show"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """List your chats/channels (requires login)."""
    from .user_client import UserClient

    client = UserClient()

    try:
        result = asyncio.run(client.get_dialogs(limit=limit))
    finally:
        asyncio.run(client.disconnect())

    if json_output:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return

    table = Table(title=f"Dialogs ({len(result)})")
    table.add_column("Name", style="cyan", max_width=30)
    table.add_column("Type", style="dim", max_width=10)
    table.add_column("ID", style="white", max_width=20)
    table.add_column("Unread", style="yellow", justify="right", max_width=6)

    for d in result:
        dtype = "channel" if d["is_channel"] else ("group" if d["is_group"] else "user")
        table.add_row(
            d["name"], dtype, str(d["id"]), str(d["unread_count"]) if d["unread_count"] else ""
        )

    console.print(table)


@app.command()
def whoami(
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Show logged-in user info (requires login)."""
    from .user_client import UserClient

    client = UserClient()

    try:
        result = asyncio.run(client.get_me())
    finally:
        asyncio.run(client.disconnect())

    if json_output:
        print(json.dumps(result, indent=2))
    else:
        console.print(
            f"[bold]User:[/] @{result['username']} ({result['first_name']} {result.get('last_name') or ''})"
        )
        console.print(f"[dim]ID: {result['id']}[/]")
        console.print(f"[dim]Phone: {result.get('phone', 'N/A')}[/]")


@app.command()
def send_photo(
    chat_id: str = typer.Argument(..., help="Chat ID or @username"),
    photo: str = typer.Argument(..., help="File ID, URL, or local path to photo"),
    caption: str | None = typer.Option(None, "--caption", "-c"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Send a photo."""
    from .client import TelegramClient; c = TelegramClient()
    result = asyncio.run(c.send_photo(chat_id, photo, caption))
    if json_output: print(json.dumps(result, indent=2)); return
    console.print(f"[green]✓[/] Photo sent as message {result['message_id']}")


@app.command()
def send_file(
    chat_id: str = typer.Argument(..., help="Chat ID or @username"),
    file: str = typer.Argument(..., help="File ID, URL, or local path"),
    caption: str | None = typer.Option(None, "--caption", "-c"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Send a document/file."""
    from .client import TelegramClient; c = TelegramClient()
    result = asyncio.run(c.send_document(chat_id, file, caption))
    if json_output: print(json.dumps(result, indent=2)); return
    console.print(f"[green]✓[/] File sent as message {result['message_id']}")


@app.command()
def edit(
    chat_id: str = typer.Argument(..., help="Chat ID"),
    message_id: int = typer.Argument(..., help="Message ID to edit"),
    text: str = typer.Argument(..., help="New text"),
    markdown: bool = typer.Option(False, "--markdown", "-m"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Edit a sent message."""
    from .client import TelegramClient; c = TelegramClient()
    result = asyncio.run(c.edit_message_text(chat_id, message_id, text,
        parse_mode="Markdown" if markdown else None))
    if json_output: print(json.dumps(result, indent=2)); return
    console.print(f"[green]✓[/] Edited message {result['message_id']}")


@app.command()
def react(
    chat_id: str = typer.Argument(..., help="Chat ID"),
    message_id: int = typer.Argument(..., help="Message ID"),
    emoji: str | None = typer.Option(None, "--emoji", "-e", help="Comma-separated emoji (empty to remove)"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Set reaction on a message."""
    from .client import TelegramClient; c = TelegramClient()
    reaction_list = [e.strip() for e in emoji.split(",")] if emoji else None
    result = asyncio.run(c.set_message_reaction(chat_id, message_id, reaction_list))
    if json_output: print(json.dumps({"ok": result}, indent=2)); return
    console.print(f"[green]✓[/] Reaction {'set' if reaction_list else 'removed'}")


@app.command()
def pin(
    chat_id: str = typer.Argument(..., help="Chat ID"),
    message_id: int = typer.Argument(..., help="Message ID to pin"),
    silent: bool = typer.Option(False, "--silent", "-s"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Pin a message."""
    from .client import TelegramClient; c = TelegramClient()
    result = asyncio.run(c.pin_chat_message(chat_id, message_id, disable_notification=silent))
    if json_output: print(json.dumps({"ok": result}, indent=2)); return
    console.print(f"[green]✓[/] Pinned message {message_id}")


@app.command()
def unpin(
    chat_id: str = typer.Argument(..., help="Chat ID"),
    message_id: int | None = typer.Option(None, "--message-id", "-m"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Unpin a message."""
    from .client import TelegramClient; c = TelegramClient()
    result = asyncio.run(c.unpin_chat_message(chat_id, message_id))
    if json_output: print(json.dumps({"ok": result}, indent=2)); return
    console.print(f"[green]✓[/] Unpinned {'message ' + str(message_id) if message_id else 'most recent'}")


@app.command()
def admins(
    chat_id: str = typer.Argument(..., help="Chat ID"),
    json_output: bool = typer.Option(False, "--json"),
):
    """List chat administrators."""
    from .client import TelegramClient; c = TelegramClient()
    result = asyncio.run(c.get_chat_administrators(chat_id))
    if json_output: print(json.dumps(result, indent=2)); return
    table = Table(title=f"Admins — {chat_id}")
    table.add_column("Username", style="cyan"); table.add_column("Status", style="yellow"); table.add_column("Title", style="white")
    for a in result: table.add_row(f"@{a['username']}" if a['username'] else f"id:{a['user_id']}", a["status"], a.get("custom_title") or "")
    console.print(table)


@app.command()
def poll(
    chat_id: str = typer.Argument(..., help="Chat ID"),
    question: str = typer.Argument(..., help="Poll question"),
    options: list[str] = typer.Argument(..., help="Poll options (space-separated)"),
    anonymous: bool = typer.Option(True, "--anonymous/--public"),
    multiple: bool = typer.Option(False, "--multiple"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Create a poll."""
    from .client import TelegramClient; c = TelegramClient()
    result = asyncio.run(c.send_poll(chat_id, question, options, anonymous, multiple))
    if json_output: print(json.dumps(result, indent=2)); return
    console.print(f"[green]✓[/] Poll sent as message {result['message_id']}")


@app.command()
def typing(
    chat_id: str = typer.Argument(..., help="Chat ID"),
    action: str = typer.Option("typing", "--action", "-a", help="typing, upload_photo, record_video, etc."),
):
    """Send typing indicator (lasts ~5 seconds)."""
    from .client import TelegramClient; c = TelegramClient()
    asyncio.run(c.send_chat_action(chat_id, action))
    console.print(f"[green]✓[/] Sent '{action}' indicator")


@app.command()
def ban(
    chat_id: str = typer.Argument(..., help="Chat ID"),
    user_id: int = typer.Argument(..., help="User ID to ban"),
):
    """Ban a user from a chat."""
    from .client import TelegramClient; c = TelegramClient()
    asyncio.run(c.ban_chat_member(chat_id, user_id))
    console.print(f"[green]✓[/] Banned user {user_id}")


@app.command()
def unban(
    chat_id: str = typer.Argument(..., help="Chat ID"),
    user_id: int = typer.Argument(..., help="User ID to unban"),
):
    """Unban a user."""
    from .client import TelegramClient; c = TelegramClient()
    asyncio.run(c.unban_chat_member(chat_id, user_id))
    console.print(f"[green]✓[/] Unbanned user {user_id}")


@app.command()
def invite_link(
    chat_id: str = typer.Argument(..., help="Chat ID"),
    name: str | None = typer.Option(None, "--name"),
    member_limit: int | None = typer.Option(None, "--limit"),
    expire_hours: int | None = typer.Option(None, "--expire-hours"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Create an invite link."""
    from .client import TelegramClient; c = TelegramClient()
    import time
    expire = int(time.time()) + expire_hours * 3600 if expire_hours else None
    result = asyncio.run(c.create_chat_invite_link(chat_id, name, expire, member_limit))
    if json_output: print(json.dumps(result, indent=2)); return
    console.print(f"[green]✓[/] Invite link: {result['invite_link']}")


@app.command()
def commands(
    set_cmds: bool = typer.Option(False, "--set", help="Set bot commands (use with --cmd pairs)"),
    cmd: list[str] | None = typer.Option(None, "--cmd", help="command:description pairs"),
    json_output: bool = typer.Option(False, "--json"),
):
    """List or set bot commands."""
    from .client import TelegramClient; c = TelegramClient()
    if set_cmds and cmd:
        import re
        parsed = [dict(zip(["command","description"], re.split(r":", entry, 1))) for entry in cmd]
        asyncio.run(c.set_my_commands(parsed))
        console.print(f"[green]✓[/] Set {len(parsed)} commands")
        return
    cmds = asyncio.run(c.get_my_commands())
    if json_output: print(json.dumps(cmds, indent=2)); return
    for entry in cmds: console.print(f"  /{entry['command']} — {entry['description']}")


@app.callback()
def main():
    """Telegram CLI for AI agents.

    Bot commands (TELEGRAM_BOT_TOKEN):
        me, send, send-photo, send-file, updates, chat, edit, react, pin,
        unpin, admins, poll, typing, ban, unban, invite-link, commands,
        forward, delete, webhook

    User commands (TELEGRAM_API_ID + TELEGRAM_API_HASH + login):
        login, whoami, dialogs, history
    """
    pass


if __name__ == "__main__":
    app()
