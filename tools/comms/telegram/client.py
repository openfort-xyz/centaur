"""Telegram Bot API client."""

import asyncio
from functools import wraps
from typing import Any

from centaur_sdk import secret
from telegram import Bot

from .error import TelegramError


def get_bot_token() -> str:
    """Get Telegram bot token from environment."""
    token = secret("TELEGRAM_BOT_TOKEN", "")
    if not token:
        raise RuntimeError(
            "TELEGRAM_BOT_TOKEN not set.\n"
            "Create a bot via @BotFather on Telegram and set the token."
        )
    return token


def run_async(func):
    """Decorator to run async functions synchronously."""

    @wraps(func)
    def wrapper(*args, **kwargs):
        return asyncio.get_event_loop().run_until_complete(func(*args, **kwargs))

    return wrapper


class TelegramClient:
    """High-level Telegram Bot API client for AI agents."""

    def __init__(self, token: str | None = None):
        """Initialize client with bot token."""
        self.token = token or get_bot_token()
        self._bot: Bot | None = None

    @property
    def bot(self) -> Bot:
        """Get or create bot instance."""
        if self._bot is None:
            self._bot = Bot(token=self.token)
        return self._bot

    async def get_me(self) -> dict[str, Any]:
        """Get bot info."""
        async with self.bot:
            me = await self.bot.get_me()
            return {
                "id": me.id,
                "username": me.username,
                "first_name": me.first_name,
                "can_join_groups": me.can_join_groups,
                "can_read_all_group_messages": me.can_read_all_group_messages,
            }

    async def send_message(
        self,
        chat_id: int | str,
        text: str,
        parse_mode: str | None = None,
        reply_to_message_id: int | None = None,
    ) -> dict[str, Any]:
        """Send a message to a chat."""
        async with self.bot:
            try:
                msg = await self.bot.send_message(
                    chat_id=chat_id,
                    text=text,
                    parse_mode=parse_mode,
                    reply_to_message_id=reply_to_message_id,
                )
                return {
                    "message_id": msg.message_id,
                    "chat_id": msg.chat.id,
                    "chat_type": msg.chat.type,
                    "chat_title": msg.chat.title or msg.chat.username,
                    "date": msg.date.isoformat(),
                    "text": msg.text,
                }
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def get_updates(
        self,
        limit: int = 100,
        timeout: int = 0,
        offset: int | None = None,
    ) -> list[dict[str, Any]]:
        """Get recent updates (messages sent to the bot)."""
        async with self.bot:
            try:
                updates = await self.bot.get_updates(
                    limit=limit,
                    timeout=timeout,
                    offset=offset,
                )
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

            results = []
            for update in updates:
                msg = update.message or update.edited_message or update.channel_post
                if msg:
                    results.append(
                        {
                            "update_id": update.update_id,
                            "message_id": msg.message_id,
                            "chat_id": msg.chat.id,
                            "chat_type": msg.chat.type,
                            "chat_title": msg.chat.title
                            or msg.chat.username
                            or msg.chat.first_name,
                            "from_user": msg.from_user.username if msg.from_user else None,
                            "from_id": msg.from_user.id if msg.from_user else None,
                            "text": msg.text or msg.caption or "",
                            "date": msg.date.isoformat(),
                        }
                    )
            return results

    async def get_chat(self, chat_id: int | str) -> dict[str, Any]:
        """Get chat info."""
        async with self.bot:
            try:
                chat = await self.bot.get_chat(chat_id=chat_id)
                return {
                    "id": chat.id,
                    "type": chat.type,
                    "title": chat.title,
                    "username": chat.username,
                    "first_name": chat.first_name,
                    "last_name": chat.last_name,
                    "description": chat.description,
                    "member_count": getattr(chat, "member_count", None),
                }
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def get_chat_member_count(self, chat_id: int | str) -> int:
        """Get number of members in a chat."""
        async with self.bot:
            try:
                return await self.bot.get_chat_member_count(chat_id=chat_id)
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def forward_message(
        self,
        chat_id: int | str,
        from_chat_id: int | str,
        message_id: int,
    ) -> dict[str, Any]:
        """Forward a message to another chat."""
        async with self.bot:
            try:
                msg = await self.bot.forward_message(
                    chat_id=chat_id,
                    from_chat_id=from_chat_id,
                    message_id=message_id,
                )
                return {
                    "message_id": msg.message_id,
                    "chat_id": msg.chat.id,
                    "date": msg.date.isoformat(),
                }
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def delete_message(self, chat_id: int | str, message_id: int) -> bool:
        """Delete a message."""
        async with self.bot:
            try:
                return await self.bot.delete_message(chat_id=chat_id, message_id=message_id)
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def set_webhook(self, url: str) -> bool:
        """Set webhook URL for receiving updates."""
        async with self.bot:
            try:
                return await self.bot.set_webhook(url=url)
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def delete_webhook(self) -> bool:
        """Delete webhook and switch to polling."""
        async with self.bot:
            try:
                return await self.bot.delete_webhook()
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def get_webhook_info(self) -> dict[str, Any]:
        """Get current webhook status."""
        async with self.bot:
            try:
                info = await self.bot.get_webhook_info()
                return {
                    "url": info.url,
                    "has_custom_certificate": info.has_custom_certificate,
                    "pending_update_count": info.pending_update_count,
                    "last_error_date": info.last_error_date.isoformat()
                    if info.last_error_date
                    else None,
                    "last_error_message": info.last_error_message,
                }
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def send_photo(
        self,
        chat_id: int | str,
        photo: str,
        caption: str | None = None,
        reply_to_message_id: int | None = None,
    ) -> dict[str, Any]:
        """Send a photo to a chat.

        Args:
            photo: File ID, HTTP URL, or local file path.
        """
        async with self.bot:
            try:
                msg = await self.bot.send_photo(
                    chat_id=chat_id,
                    photo=photo,
                    caption=caption,
                    reply_to_message_id=reply_to_message_id,
                )
                return {
                    "message_id": msg.message_id,
                    "chat_id": msg.chat.id,
                    "photo_sizes": [{"width": p.width, "height": p.height,
                                    "file_id": p.file_id} for p in msg.photo],
                }
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def send_document(
        self,
        chat_id: int | str,
        document: str,
        caption: str | None = None,
        reply_to_message_id: int | None = None,
    ) -> dict[str, Any]:
        """Send a document/file to a chat.

        Args:
            document: File ID, HTTP URL, or local file path.
        """
        async with self.bot:
            try:
                msg = await self.bot.send_document(
                    chat_id=chat_id,
                    document=document,
                    caption=caption,
                    reply_to_message_id=reply_to_message_id,
                )
                return {
                    "message_id": msg.message_id,
                    "chat_id": msg.chat.id,
                    "document": {
                        "file_name": msg.document.file_name if msg.document else None,
                        "file_id": msg.document.file_id if msg.document else None,
                        "file_size": msg.document.file_size if msg.document else None,
                    },
                }
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def send_audio(
        self,
        chat_id: int | str,
        audio: str,
        caption: str | None = None,
        title: str | None = None,
    ) -> dict[str, Any]:
        """Send an audio file."""
        async with self.bot:
            try:
                msg = await self.bot.send_audio(
                    chat_id=chat_id,
                    audio=audio,
                    caption=caption,
                    title=title,
                )
                return {"message_id": msg.message_id, "chat_id": msg.chat.id}
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def send_video(
        self,
        chat_id: int | str,
        video: str,
        caption: str | None = None,
        supports_streaming: bool = True,
    ) -> dict[str, Any]:
        """Send a video."""
        async with self.bot:
            try:
                msg = await self.bot.send_video(
                    chat_id=chat_id,
                    video=video,
                    caption=caption,
                    supports_streaming=supports_streaming,
                )
                return {"message_id": msg.message_id, "chat_id": msg.chat.id}
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def send_voice(
        self, chat_id: int | str, voice: str, caption: str | None = None
    ) -> dict[str, Any]:
        """Send a voice note."""
        async with self.bot:
            try:
                msg = await self.bot.send_voice(
                    chat_id=chat_id, voice=voice, caption=caption
                )
                return {"message_id": msg.message_id, "chat_id": msg.chat.id}
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def send_sticker(
        self, chat_id: int | str, sticker: str
    ) -> dict[str, Any]:
        """Send a sticker."""
        async with self.bot:
            try:
                msg = await self.bot.send_sticker(chat_id=chat_id, sticker=sticker)
                return {"message_id": msg.message_id, "chat_id": msg.chat.id}
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def send_poll(
        self,
        chat_id: int | str,
        question: str,
        options: list[str],
        is_anonymous: bool = True,
        allows_multiple_answers: bool = False,
    ) -> dict[str, Any]:
        """Send a native poll."""
        async with self.bot:
            try:
                msg = await self.bot.send_poll(
                    chat_id=chat_id,
                    question=question,
                    options=options,
                    is_anonymous=is_anonymous,
                    allows_multiple_answers=allows_multiple_answers,
                )
                return {"message_id": msg.message_id, "chat_id": msg.chat.id,
                        "poll_id": msg.poll.id if msg.poll else None}
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def send_chat_action(
        self, chat_id: int | str, action: str = "typing"
    ) -> bool:
        """Send chat action (typing, upload_photo, record_video, etc.).

        Shows a status indicator in the chat for ~5 seconds.
        """
        async with self.bot:
            try:
                return await self.bot.send_chat_action(
                    chat_id=chat_id, action=action
                )
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def edit_message_text(
        self,
        chat_id: int | str,
        message_id: int,
        text: str,
        parse_mode: str | None = None,
    ) -> dict[str, Any]:
        """Edit an existing message text."""
        async with self.bot:
            try:
                msg = await self.bot.edit_message_text(
                    chat_id=chat_id,
                    message_id=message_id,
                    text=text,
                    parse_mode=parse_mode,
                )
                return {"message_id": msg.message_id, "chat_id": msg.chat.id,
                        "text": msg.text}
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def set_message_reaction(
        self,
        chat_id: int | str,
        message_id: int,
        reaction: list[str] | None = None,
        is_big: bool = False,
    ) -> bool:
        """Set a reaction on a message. Pass empty list to remove.

        Args:
            reaction: List of emoji to react with (e.g. ["👍", "❤️"]).
                      Pass None or [] to remove all reactions.
        """
        async with self.bot:
            try:
                from telegram import ReactionTypeEmoji
                reactions = (
                    [ReactionTypeEmoji(emoji=r) for r in reaction]
                    if reaction
                    else []
                )
                return await self.bot.set_message_reaction(
                    chat_id=chat_id,
                    message_id=message_id,
                    reaction=reactions,
                    is_big=is_big,
                )
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def pin_chat_message(
        self,
        chat_id: int | str,
        message_id: int,
        disable_notification: bool = False,
    ) -> bool:
        """Pin a message in a chat."""
        async with self.bot:
            try:
                return await self.bot.pin_chat_message(
                    chat_id=chat_id,
                    message_id=message_id,
                    disable_notification=disable_notification,
                )
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def unpin_chat_message(
        self, chat_id: int | str, message_id: int | None = None
    ) -> bool:
        """Unpin a message. If message_id not given, unpins the most recent."""
        async with self.bot:
            try:
                return await self.bot.unpin_chat_message(
                    chat_id=chat_id, message_id=message_id
                )
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def get_chat_administrators(
        self, chat_id: int | str
    ) -> list[dict[str, Any]]:
        """Get list of administrators in a chat."""
        async with self.bot:
            try:
                admins = await self.bot.get_chat_administrators(chat_id=chat_id)
                return [
                    {
                        "user_id": a.user.id,
                        "username": a.user.username,
                        "first_name": a.user.first_name,
                        "is_bot": a.user.is_bot,
                        "status": a.status,
                        "can_be_edited": a.can_be_edited,
                        "is_anonymous": a.is_anonymous,
                        "custom_title": a.custom_title,
                    }
                    for a in admins
                ]
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def get_chat_member(
        self, chat_id: int | str, user_id: int
    ) -> dict[str, Any]:
        """Get info about a specific chat member."""
        async with self.bot:
            try:
                member = await self.bot.get_chat_member(
                    chat_id=chat_id, user_id=user_id
                )
                return {
                    "user_id": member.user.id,
                    "username": member.user.username,
                    "first_name": member.user.first_name,
                    "is_bot": member.user.is_bot,
                    "status": member.status,
                    "can_send_messages": getattr(member, "can_send_messages", None),
                    "can_send_media": getattr(member, "can_send_media_messages", None),
                }
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def ban_chat_member(
        self, chat_id: int | str, user_id: int, revoke_messages: bool = False
    ) -> bool:
        """Ban a user from a chat."""
        async with self.bot:
            try:
                return await self.bot.ban_chat_member(
                    chat_id=chat_id,
                    user_id=user_id,
                    revoke_messages=revoke_messages,
                )
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def unban_chat_member(
        self, chat_id: int | str, user_id: int
    ) -> bool:
        """Unban a previously banned user."""
        async with self.bot:
            try:
                return await self.bot.unban_chat_member(
                    chat_id=chat_id, user_id=user_id
                )
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def restrict_chat_member(
        self,
        chat_id: int | str,
        user_id: int,
        can_send_messages: bool = False,
        can_send_media: bool = False,
        can_send_other: bool = False,
        can_add_web_page_previews: bool = False,
    ) -> bool:
        """Restrict a user's permissions in a chat."""
        async with self.bot:
            try:
                from telegram import ChatPermissions
                return await self.bot.restrict_chat_member(
                    chat_id=chat_id,
                    user_id=user_id,
                    permissions=ChatPermissions(
                        can_send_messages=can_send_messages,
                        can_send_media_messages=can_send_media,
                        can_send_other_messages=can_send_other,
                        can_add_web_page_previews=can_add_web_page_previews,
                    ),
                )
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def create_chat_invite_link(
        self,
        chat_id: int | str,
        name: str | None = None,
        expire_date: int | None = None,
        member_limit: int | None = None,
    ) -> dict[str, Any]:
        """Create an additional invite link for a chat."""
        async with self.bot:
            try:
                link = await self.bot.create_chat_invite_link(
                    chat_id=chat_id,
                    name=name,
                    expire_date=expire_date,
                    member_limit=member_limit,
                )
                return {
                    "invite_link": link.invite_link,
                    "creator": link.creator.username if link.creator else None,
                    "name": link.name,
                    "expire_date": link.expire_date.isoformat()
                    if link.expire_date
                    else None,
                    "member_limit": link.member_limit,
                }
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def export_chat_invite_link(self, chat_id: int | str) -> str:
        """Generate a new primary invite link for a chat."""
        async with self.bot:
            try:
                return await self.bot.export_chat_invite_link(chat_id=chat_id)
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def get_file(self, file_id: str) -> dict[str, Any]:
        """Get file info by file_id."""
        async with self.bot:
            try:
                f = await self.bot.get_file(file_id=file_id)
                return {
                    "file_id": f.file_id,
                    "file_unique_id": f.file_unique_id,
                    "file_size": f.file_size,
                    "file_path": f.file_path,
                }
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def answer_callback_query(
        self,
        callback_query_id: str,
        text: str | None = None,
        show_alert: bool = False,
    ) -> bool:
        """Answer a callback query from an inline keyboard."""
        async with self.bot:
            try:
                return await self.bot.answer_callback_query(
                    callback_query_id=callback_query_id,
                    text=text,
                    show_alert=show_alert,
                )
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def get_user_profile_photos(
        self, user_id: int, limit: int = 10
    ) -> list[dict[str, Any]]:
        """Get a user's profile photos."""
        async with self.bot:
            try:
                photos = await self.bot.get_user_profile_photos(
                    user_id=user_id, limit=limit
                )
                result = []
                for photo_set in photos.photos:
                    for size in photo_set:
                        result.append({
                            "file_id": size.file_id,
                            "width": size.width,
                            "height": size.height,
                        })
                return result
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def set_chat_title(self, chat_id: int | str, title: str) -> bool:
        """Change the title of a chat."""
        async with self.bot:
            try:
                return await self.bot.set_chat_title(
                    chat_id=chat_id, title=title
                )
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def set_chat_description(
        self, chat_id: int | str, description: str | None = None
    ) -> bool:
        """Change the description of a chat."""
        async with self.bot:
            try:
                return await self.bot.set_chat_description(
                    chat_id=chat_id, description=description
                )
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def leave_chat(self, chat_id: int | str) -> bool:
        """Bot leaves a group, supergroup, or channel."""
        async with self.bot:
            try:
                return await self.bot.leave_chat(chat_id=chat_id)
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def get_chat_members_count(self, chat_id: int | str) -> int:
        """Get the number of members in a chat."""
        async with self.bot:
            try:
                return await self.bot.get_chat_member_count(chat_id=chat_id)
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def set_my_commands(
        self,
        commands: list[dict[str, str]],
        language_code: str | None = None,
    ) -> bool:
        """Set the bot's list of commands.

        Args:
            commands: List of {"command": "start", "description": "Start the bot"}
        """
        async with self.bot:
            try:
                from telegram import BotCommand
                cmd_objs = [BotCommand(c["command"], c["description"]) for c in commands]
                return await self.bot.set_my_commands(
                    commands=cmd_objs, language_code=language_code
                )
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def get_my_commands(self) -> list[dict[str, str]]:
        """Get the bot's current list of commands."""
        async with self.bot:
            try:
                cmds = await self.bot.get_my_commands()
                return [{"command": c.command, "description": c.description} for c in cmds]
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")

    async def set_my_description(
        self, description: str | None = None, language_code: str | None = None
    ) -> bool:
        """Set the bot's description."""
        async with self.bot:
            try:
                return await self.bot.set_my_description(
                    description=description, language_code=language_code
                )
            except TelegramError as e:
                raise RuntimeError(f"Telegram API error: {e}")


# Sync convenience functions
def get_client(token: str | None = None) -> TelegramClient:
    """Get a TelegramClient instance."""
    return TelegramClient(token=token)


def send_message(chat_id: int | str, text: str, **kwargs) -> dict[str, Any]:
    """Send a message (sync wrapper)."""
    client = get_client()
    return asyncio.run(client.send_message(chat_id, text, **kwargs))


def get_updates(limit: int = 100, **kwargs) -> list[dict[str, Any]]:
    """Get updates (sync wrapper)."""
    client = get_client()
    return asyncio.run(client.get_updates(limit=limit, **kwargs))


def get_chat(chat_id: int | str) -> dict[str, Any]:
    """Get chat info (sync wrapper)."""
    client = get_client()
    return asyncio.run(client.get_chat(chat_id))


def _client() -> TelegramClient:
    return TelegramClient()
