from __future__ import annotations

import asyncio

from workflows import console_workflow


class FakeContext:
    run_id = "run-123"
    task_id = "task-456"

    def __init__(
        self,
        result_text: str = "Daily summary",
        output_lines=None,
        slack_response_channel=None,
    ) -> None:
        self.result_text = result_text
        self.output_lines = output_lines or []
        self.slack_response_channel = slack_response_channel
        self.agent_calls = []
        self.step_calls = []
        self.step_results = {}
        self.slack_calls = []
        self.google_chat_calls = []
        self.dm_setup_calls = []

    async def agent_turn(self, prompt, **kwargs):
        self.agent_calls.append((prompt, kwargs))
        return {
            "result_text": self.result_text,
            "output_lines": self.output_lines,
            "execution_id": "exec-123",
        }

    async def step(self, name, fn):
        self.step_calls.append(name)
        if name not in self.step_results:
            self.step_results[name] = await fn()
        return self.step_results[name]

    async def post_to_slack(self, channel, text, **kwargs):
        self.slack_calls.append((channel, text, kwargs))
        return {
            "channel": self.slack_response_channel or channel,
            "ts": f"123.{len(self.slack_calls)}",
        }


    async def post_to_google_chat(self, space_name, text, **kwargs):
        self.google_chat_calls.append((space_name, text, kwargs))
        index = len(self.google_chat_calls)
        return {
            "name": f"{space_name}/messages/msg-{index}",
            "thread": {"name": f"{space_name}/threads/thread-1"},
        }

    async def google_chat_dm_setup(self, target_identity):
        self.dm_setup_calls.append(target_identity)
        return {"name": "spaces/DM123", "type": "DM"}


class ThreadlessContext(FakeContext):
    async def post_to_google_chat(self, space_name, text, **kwargs):
        self.google_chat_calls.append((space_name, text, kwargs))
        return {"name": f"{space_name}/messages/msg-{len(self.google_chat_calls)}"}


def scheduled_task_blocks(body: str, footer: str):
    blocks = []
    if body:
        blocks.append(
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": body},
            }
        )
    blocks.append(
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": footer}],
        }
    )
    return blocks


def test_handler_runs_one_scoped_agent_turn_and_delivers_its_text():
    context = FakeContext()
    footer = "Sent by <@U0123456789>'s scheduled task"

    result = asyncio.run(
        console_workflow.handler(
            {
                "prompt": "Summarize open incidents",
                "principal": "console-user-author",
                "channel": "C0123456789",
                "slack_user_id": "U0123456789",
                "scheduled_task_id": "tsk_123",
                "scheduled_task_name": "Incident summary",
            },
            context,
        )
    )

    assert len(context.agent_calls) == 1
    prompt, kwargs = context.agent_calls[0]
    assert prompt == (
        f"{console_workflow.SCHEDULED_TASK_EXECUTION_INSTRUCTIONS}\n\n"
        "Task to execute:\nSummarize open incidents\n\n"
        f"{console_workflow.SLACK_MRKDWN_INSTRUCTIONS}"
    )
    assert kwargs["principal"] == "console-user-author"
    assert "thread_key" not in kwargs
    assert kwargs["metadata"] == {
        "scheduled_task_id": "tsk_123",
        "scheduled_task_name": "Incident summary",
    }
    assert context.step_calls == ["post_result"]
    assert context.slack_calls == [
        (
            "C0123456789",
            f"Daily summary\n\n{footer}",
            {
                "mrkdwn": True,
                "blocks": scheduled_task_blocks("Daily summary", footer),
            },
        )
    ]
    assert result["delivery"]["ts"] == "123.1"


def test_handler_treats_recurring_language_as_an_instruction_to_execute_now():
    context = FakeContext()
    task = (
        "Each Monday, review my Google Calendar for the upcoming "
        "Monday-through-Sunday week and my recent Slack conversations."
    )

    asyncio.run(
        console_workflow.handler(
            {
                "prompt": task,
                "principal": "console-user-author",
                "channel": "C0123456789",
                "slack_user_id": "U0123456789",
                "scheduled_task_id": "tsk_123",
            },
            context,
        )
    )

    prompt, _kwargs = context.agent_calls[0]
    assert prompt.startswith(
        "This is a run of an existing scheduled task. Execute the task now.\n"
        "NEVER create or update a scheduled task"
    )
    assert f"Task to execute:\n{task}\n\n" in prompt


def test_handler_threads_and_truncates_long_channel_results():
    response_text = "x" * (console_workflow.SLACK_MESSAGE_MAX_LENGTH + 25)
    context = FakeContext(result_text=response_text)

    result = asyncio.run(
        console_workflow.handler(
            {
                "prompt": "Summarize open incidents",
                "principal": "console-user-author",
                "channel": "C0123456789",
                "slack_user_id": "U0123456789",
                "scheduled_task_id": "tsk_123",
            },
            context,
        )
    )

    expected_chunks = (
        console_workflow.SLACK_MESSAGE_MAX_LENGTH
        + console_workflow.SLACK_MESSAGE_CHUNK_MAX_LENGTH
        - 1
    ) // console_workflow.SLACK_MESSAGE_CHUNK_MAX_LENGTH
    assert context.step_calls == ["post_result"] + [
        f"post_result_reply_{index}" for index in range(1, expected_chunks)
    ]
    assert len(context.slack_calls) == expected_chunks
    footer = "Sent by <@U0123456789>'s scheduled task"
    body_limit = console_workflow.SLACK_MESSAGE_MAX_LENGTH - len(footer) - 2
    assert "".join(call[1] for call in context.slack_calls) == (
        f"{response_text[:body_limit]}\n\n{footer}"
    )
    assert all(
        len(call[1]) <= console_workflow.SLACK_MESSAGE_CHUNK_MAX_LENGTH
        for call in context.slack_calls
    )
    assert context.slack_calls[0][2] == {"mrkdwn": True}
    assert all(
        call[2] == {"mrkdwn": True, "thread_ts": "123.1"}
        for call in context.slack_calls[1:-1]
    )
    final_body = context.slack_calls[-1][1].removesuffix(f"\n\n{footer}")
    assert context.slack_calls[-1][2] == {
        "thread_ts": "123.1",
        "mrkdwn": True,
        "blocks": scheduled_task_blocks(final_body, footer),
    }
    assert result["delivery"]["ts"] == "123.1"


def test_handler_posts_long_dm_results_as_replies_to_the_first_message():
    response_text = "a" * (console_workflow.SLACK_MESSAGE_CHUNK_MAX_LENGTH * 2 + 25)
    context = FakeContext(result_text=response_text, slack_response_channel="D0123456789")
    params = {
        "prompt": "Summarize open incidents",
        "principal": "console-user-author",
        "channel": "U0123456789",
        "slack_user_id": "U0123456789",
        "scheduled_task_id": "tsk_123",
    }

    result = asyncio.run(console_workflow.handler(params, context))

    assert context.step_calls == [
        "post_result",
        "post_result_reply_1",
        "post_result_reply_2",
    ]
    assert "".join(call[1] for call in context.slack_calls) == (
        f"{response_text}\n\nSent by <@U0123456789>'s scheduled task"
    )
    assert all(
        len(call[1]) <= console_workflow.SLACK_MESSAGE_CHUNK_MAX_LENGTH
        for call in context.slack_calls
    )
    assert context.slack_calls[0] == (
        "U0123456789",
        "a" * console_workflow.SLACK_MESSAGE_CHUNK_MAX_LENGTH,
        {"mrkdwn": True},
    )
    assert all(
        call[0] == "D0123456789"
        and call[2] == {"mrkdwn": True, "thread_ts": "123.1"}
        for call in context.slack_calls[1:-1]
    )
    footer = "Sent by <@U0123456789>'s scheduled task"
    final_body = context.slack_calls[-1][1].removesuffix(f"\n\n{footer}")
    assert context.slack_calls[-1] == (
        "D0123456789",
        f"{final_body}\n\n{footer}",
        {
            "thread_ts": "123.1",
            "mrkdwn": True,
            "blocks": scheduled_task_blocks(final_body, footer),
        },
    )
    assert len(result["delivery"]["replies"]) == 2

    asyncio.run(console_workflow.handler(params, context))

    assert context.step_calls == [
        "post_result",
        "post_result_reply_1",
        "post_result_reply_2",
    ] * 2
    assert len(context.slack_calls) == 3


def test_handler_delivers_canonical_result_text_instead_of_output_lines():
    body = (
        "Cold scoops kiss the cone\n"
        "Summer sunlight melts to cream\n"
        "Sweet stars on my tongue"
    )
    footer = "Sent by <@U0123456789>'s scheduled task"
    context = FakeContext(
        result_text=body,
        output_lines=["Commentary...", "Downloading packages...", "Traceback..."],
    )

    asyncio.run(
        console_workflow.handler(
            {
                "prompt": "Write a haiku about ice cream",
                "principal": "console-user-author",
                "channel": "C0123456789",
                "slack_user_id": "U0123456789",
                "scheduled_task_id": "tsk_123",
            },
            context,
        )
    )

    assert context.slack_calls == [
        (
            "C0123456789",
            f"{body}\n\n{footer}",
            {
                "mrkdwn": True,
                "blocks": scheduled_task_blocks(body, footer),
            },
        )
    ]


def test_handler_does_not_repeat_checkpointed_slack_posts():
    context = FakeContext()
    footer = "Sent by <@U0123456789>'s scheduled task"
    params = {
        "prompt": "Summarize open incidents",
        "principal": "console-user-author",
        "channel": "C0123456789",
        "slack_user_id": "U0123456789",
        "scheduled_task_id": "tsk_123",
    }

    asyncio.run(console_workflow.handler(params, context))
    asyncio.run(console_workflow.handler(params, context))

    assert context.step_calls == ["post_result", "post_result"]
    assert context.slack_calls == [
        (
            "C0123456789",
            f"Daily summary\n\n{footer}",
            {
                "mrkdwn": True,
                "blocks": scheduled_task_blocks("Daily summary", footer),
            },
        )
    ]


def test_handler_uses_a_generic_footer_for_an_in_flight_run_without_an_author():
    context = FakeContext()
    footer = "Sent by a scheduled task"

    asyncio.run(
        console_workflow.handler(
            {
                "prompt": "Summarize open incidents",
                "principal": "console-user-author",
                "channel": "C0123456789",
                "scheduled_task_id": "tsk_123",
            },
            context,
        )
    )

    assert context.slack_calls == [
        (
            "C0123456789",
            f"Daily summary\n\n{footer}",
            {
                "mrkdwn": True,
                "blocks": scheduled_task_blocks("Daily summary", footer),
            },
        )
    ]


def test_handler_rejects_missing_required_input_before_starting_an_agent():
    context = FakeContext()

    try:
        asyncio.run(console_workflow.handler({}, context))
    except ValueError as error:
        assert str(error) == "console_workflow requires prompt"
    else:
        raise AssertionError("expected invalid input to fail")

    assert context.agent_calls == []
    assert context.step_calls == []
    assert context.slack_calls == []


def test_handler_delivers_to_a_google_chat_space_with_chat_formatting():
    context = FakeContext()
    footer = "Sent by author@example.com's scheduled task"

    result = asyncio.run(
        console_workflow.handler(
            {
                "prompt": "Summarize open incidents",
                "principal": "console-user-author",
                "channel": "spaces/AAQA42QLdws",
                "author_email": "author@example.com",
                "scheduled_task_id": "tsk_123",
                "scheduled_task_name": "Incident summary",
            },
            context,
        )
    )

    prompt, kwargs = context.agent_calls[0]
    assert prompt == (
        f"{console_workflow.SCHEDULED_TASK_EXECUTION_INSTRUCTIONS}\n\n"
        "Task to execute:\nSummarize open incidents\n\n"
        f"{console_workflow.GCHAT_FORMAT_INSTRUCTIONS}"
    )
    assert kwargs["principal"] == "console-user-author"
    assert context.step_calls == ["post_result"]
    assert context.slack_calls == []
    assert context.dm_setup_calls == []
    assert context.google_chat_calls == [
        ("spaces/AAQA42QLdws", f"Daily summary\n\n{footer}", {})
    ]
    assert result["delivery"] == {
        "space_name": "spaces/AAQA42QLdws",
        "messages_posted": 1,
        "thread_name": "spaces/AAQA42QLdws/threads/thread-1",
    }


def test_handler_threads_long_google_chat_results_under_the_first_message():
    response_text = "x" * (console_workflow.GCHAT_MESSAGE_CHUNK_MAX_LENGTH * 2 + 25)
    context = FakeContext(result_text=response_text)

    result = asyncio.run(
        console_workflow.handler(
            {
                "prompt": "Summarize open incidents",
                "principal": "console-user-author",
                "channel": "spaces/AAQA42QLdws",
                "author_email": "author@example.com",
                "scheduled_task_id": "tsk_123",
            },
            context,
        )
    )

    footer = "Sent by author@example.com's scheduled task"
    assert context.step_calls == [
        "post_result",
        "post_result_reply_1",
        "post_result_reply_2",
    ]
    assert "".join(call[1] for call in context.google_chat_calls) == (
        f"{response_text}\n\n{footer}"
    )
    assert all(
        len(call[1]) <= console_workflow.GCHAT_MESSAGE_CHUNK_MAX_LENGTH
        for call in context.google_chat_calls
    )
    assert context.google_chat_calls[0][2] == {}
    thread_name = "spaces/AAQA42QLdws/threads/thread-1"
    assert all(
        call[2] == {"thread_name": thread_name} for call in context.google_chat_calls[1:]
    )
    assert result["delivery"]["messages_posted"] == 3


def test_handler_resolves_the_author_dm_space_once_and_replays_checkpoints():
    response_text = "a" * (console_workflow.GCHAT_MESSAGE_CHUNK_MAX_LENGTH + 25)
    context = FakeContext(result_text=response_text)
    params = {
        "prompt": "Summarize open incidents",
        "principal": "console-user-author",
        "channel": "author@example.com",
        "author_email": "author@example.com",
        "scheduled_task_id": "tsk_123",
    }

    result = asyncio.run(console_workflow.handler(params, context))

    assert context.dm_setup_calls == ["author@example.com"]
    assert context.step_calls == ["dm_setup", "post_result", "post_result_reply_1"]
    assert [call[0] for call in context.google_chat_calls] == ["spaces/DM123"] * 2
    assert result["delivery"]["space_name"] == "spaces/DM123"

    asyncio.run(console_workflow.handler(params, context))

    assert context.dm_setup_calls == ["author@example.com"]
    assert len(context.google_chat_calls) == 2
    assert context.step_calls == ["dm_setup", "post_result", "post_result_reply_1"] * 2


def test_handler_posts_unthreaded_google_chat_replies_without_a_thread_name():
    response_text = "b" * (console_workflow.GCHAT_MESSAGE_CHUNK_MAX_LENGTH + 25)
    context = ThreadlessContext(result_text=response_text)

    result = asyncio.run(
        console_workflow.handler(
            {
                "prompt": "Summarize open incidents",
                "principal": "console-user-author",
                "channel": "spaces/AAQA42QLdws",
                "author_email": "author@example.com",
                "scheduled_task_id": "tsk_123",
            },
            context,
        )
    )

    assert len(context.google_chat_calls) == 2
    assert all(call[2] == {} for call in context.google_chat_calls)
    assert result["delivery"]["thread_name"] == ""


def test_handler_uses_the_generic_footer_for_google_chat_without_an_author():
    context = FakeContext()

    asyncio.run(
        console_workflow.handler(
            {
                "prompt": "Summarize open incidents",
                "principal": "console-user-author",
                "channel": "spaces/AAQA42QLdws",
                "scheduled_task_id": "tsk_123",
            },
            context,
        )
    )

    assert context.google_chat_calls == [
        ("spaces/AAQA42QLdws", "Daily summary\n\nSent by a scheduled task", {})
    ]


def test_handler_still_routes_slack_shaped_destinations_to_slack():
    context = FakeContext()

    asyncio.run(
        console_workflow.handler(
            {
                "prompt": "Summarize open incidents",
                "principal": "console-user-author",
                "channel": "C0123456789",
                "slack_user_id": "U0123456789",
                "author_email": "author@example.com",
                "scheduled_task_id": "tsk_123",
            },
            context,
        )
    )

    prompt, _kwargs = context.agent_calls[0]
    assert prompt.endswith(console_workflow.SLACK_MRKDWN_INSTRUCTIONS)
    assert context.google_chat_calls == []
    assert context.dm_setup_calls == []
    assert len(context.slack_calls) == 1
