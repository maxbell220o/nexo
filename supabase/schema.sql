create table public.quizzes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 100),
  questions jsonb not null check (jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) > 0),
  created_at timestamptz not null default now()
);

alter table public.quizzes enable row level security;

create policy "Teachers manage their own quizzes"
  on public.quizzes
  for all
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

grant select, insert, update, delete on public.quizzes to authenticated;

create table public.quiz_games (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  code text not null unique check (code ~ '^[0-9]{6}$'),
  status text not null default 'waiting' check (status in ('waiting', 'question', 'finished')),
  current_question integer not null default -1,
  question_started_at timestamptz,
  scoreboard_revealed boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.quiz_players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.quiz_games(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 24),
  score integer not null default 0 check (score >= 0),
  joined_at timestamptz not null default now(),
  unique (game_id, name)
);

create table public.quiz_answers (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.quiz_games(id) on delete cascade,
  player_id uuid not null references public.quiz_players(id) on delete cascade,
  question_index integer not null check (question_index >= 0),
  answer_index integer not null check (answer_index between 0 and 5),
  is_correct boolean not null,
  points_earned integer not null default 0 check (points_earned >= 0),
  answered_at timestamptz not null default now(),
  unique (player_id, question_index, answer_index)
);

alter table public.quiz_games enable row level security;
alter table public.quiz_players enable row level security;
alter table public.quiz_answers enable row level security;

create policy "Teachers read their own games"
  on public.quiz_games
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

revoke all on public.quiz_games, public.quiz_players, public.quiz_answers from anon, authenticated;

create or replace function public.start_quiz_game(p_quiz_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'Bitte melde dich als Lehrkraft an.';
  end if;

  if not exists (
    select 1 from public.quizzes
    where id = p_quiz_id and owner_id = auth.uid()
  ) then
    raise exception 'Quiz nicht gefunden oder kein Zugriff.';
  end if;

  loop
    v_code := lpad(floor(random() * 1000000)::text, 6, '0');
    exit when not exists (select 1 from public.quiz_games where code = v_code);
  end loop;

  insert into public.quiz_games (quiz_id, owner_id, code)
  values (p_quiz_id, auth.uid(), v_code);

  return v_code;
end;
$$;

create or replace function public.quiz_question_time_limit(p_game_id uuid, p_question_index integer)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_time_limit integer;
begin
  select coalesce((q.questions -> p_question_index ->> 'timeLimitSeconds')::integer, 30)
  into v_time_limit
  from public.quiz_games g
  join public.quizzes q on q.id = g.quiz_id
  where g.id = p_game_id;
  if v_time_limit is null or v_time_limit not between 5 and 120 then
    raise exception 'Das Zeitlimit muss zwischen 5 und 120 Sekunden liegen.';
  end if;
  return v_time_limit;
end;
$$;

create or replace function public.advance_quiz_game(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.quiz_games%rowtype;
  v_question_count integer;
  v_player_count integer;
  v_answered_count integer;
  v_answer_revealed boolean;
  v_result jsonb;
begin
  select * into v_game
  from public.quiz_games
  where code = p_code and owner_id = auth.uid()
  for update;

  if not found then
    raise exception 'Spiel nicht gefunden oder kein Zugriff.';
  end if;

  select jsonb_array_length(questions) into v_question_count
  from public.quizzes where id = v_game.quiz_id;

  if v_game.status = 'waiting' then
    update public.quiz_games
    set status = 'question', current_question = 0, question_started_at = clock_timestamp(), scoreboard_revealed = false
    where id = v_game.id;
  elsif v_game.status = 'question' then
    select count(*) into v_player_count
    from public.quiz_players where game_id = v_game.id;
    select count(distinct player_id) into v_answered_count
    from public.quiz_answers
    where game_id = v_game.id and question_index = v_game.current_question;
    v_answer_revealed :=
      clock_timestamp() >= coalesce(v_game.question_started_at, clock_timestamp()) + interval '15 seconds'
      and (
        clock_timestamp() >= coalesce(v_game.question_started_at, clock_timestamp()) + interval '15 seconds'
          + (public.quiz_question_time_limit(v_game.id, v_game.current_question) * interval '1 second')
        or (v_player_count > 0 and v_answered_count >= v_player_count)
      );
    if not v_answer_revealed then
      raise exception 'Die Frage läuft noch. Warte, bis alle geantwortet haben oder die Zeit abläuft.';
    end if;

    if not v_game.scoreboard_revealed then
      if v_game.current_question + 1 = v_question_count then
        update public.quiz_games
        set status = 'finished', question_started_at = null, scoreboard_revealed = false
        where id = v_game.id;
      else
        update public.quiz_games set scoreboard_revealed = true where id = v_game.id;
      end if;
    else
      if v_game.current_question + 1 < v_question_count then
        update public.quiz_games
        set current_question = current_question + 1, question_started_at = clock_timestamp(), scoreboard_revealed = false
        where id = v_game.id;
      else
        update public.quiz_games
        set status = 'finished', question_started_at = null, scoreboard_revealed = false
        where id = v_game.id;
      end if;
    end if;
  else
    raise exception 'Das Quiz ist bereits beendet.';
  end if;

  select jsonb_build_object(
    'status', status,
    'current_question', current_question
  ) into v_result
  from public.quiz_games where code = p_code;

  return v_result;
end;
$$;

create or replace function public.get_teacher_game_state(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_game public.quiz_games%rowtype;
  v_player_count integer;
  v_answered_count integer;
  v_answer_revealed boolean;
begin
  select * into v_game from public.quiz_games where code = p_code and owner_id = auth.uid();
  if not found then
    raise exception 'Spiel nicht gefunden oder kein Zugriff.';
  end if;

  select count(*) into v_player_count from public.quiz_players where game_id = v_game.id;
  select count(distinct player_id) into v_answered_count
  from public.quiz_answers
  where game_id = v_game.id and question_index = v_game.current_question;
  v_answer_revealed := v_game.status = 'question' and (
    clock_timestamp() >= coalesce(v_game.question_started_at, clock_timestamp()) + interval '15 seconds'
    and (
      clock_timestamp() >= coalesce(v_game.question_started_at, clock_timestamp()) + interval '15 seconds'
        + (public.quiz_question_time_limit(v_game.id, v_game.current_question) * interval '1 second')
      or (v_player_count > 0 and v_answered_count >= v_player_count)
    )
  );

  select jsonb_build_object(
    'code', g.code,
    'status', g.status,
    'current_question', g.current_question,
    'question_count', jsonb_array_length(q.questions),
    'reading_deadline', case when g.status = 'question' then g.question_started_at + interval '15 seconds' else null end,
    'deadline', case when g.status = 'question' then g.question_started_at + interval '15 seconds'
      + (public.quiz_question_time_limit(g.id, g.current_question) * interval '1 second') else null end,
    'answer_phase_started', g.status = 'question'
      and clock_timestamp() >= g.question_started_at + interval '15 seconds',
    'answer_revealed', v_answer_revealed,
    'scoreboard_revealed', g.scoreboard_revealed,
    'answered_count', v_answered_count,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.name, 'score', p.score) order by p.score desc, p.joined_at)
      from public.quiz_players p where p.game_id = g.id
    ), '[]'::jsonb)
  ) into v_result
  from public.quiz_games g
  join public.quizzes q on q.id = g.quiz_id
  where g.code = p_code and g.owner_id = auth.uid();

  if v_result is null then
    raise exception 'Spiel nicht gefunden oder kein Zugriff.';
  end if;
  return v_result;
end;
$$;

create or replace function public.get_public_quiz_display(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_game public.quiz_games%rowtype;
  v_player_count integer;
  v_answered_count integer;
  v_answer_revealed boolean;
begin
  select * into v_game from public.quiz_games where code = p_code;
  if not found then
    raise exception 'Dieses Quiz wurde nicht gefunden.';
  end if;

  select count(*) into v_player_count from public.quiz_players where game_id = v_game.id;
  select count(distinct player_id) into v_answered_count
  from public.quiz_answers
  where game_id = v_game.id and question_index = v_game.current_question;
  v_answer_revealed := v_game.status = 'question' and (
    clock_timestamp() >= coalesce(v_game.question_started_at, clock_timestamp()) + interval '15 seconds'
    and (
      clock_timestamp() >= coalesce(v_game.question_started_at, clock_timestamp()) + interval '15 seconds'
        + (public.quiz_question_time_limit(v_game.id, v_game.current_question) * interval '1 second')
      or (v_player_count > 0 and v_answered_count >= v_player_count)
    )
  );

  select jsonb_build_object(
    'code', g.code,
    'title', q.title,
    'status', g.status,
    'current_question', g.current_question,
    'question_count', jsonb_array_length(q.questions),
    'reading_deadline', case when g.status = 'question' then g.question_started_at + interval '15 seconds' else null end,
    'deadline', case when g.status = 'question' then g.question_started_at + interval '15 seconds'
      + (public.quiz_question_time_limit(g.id, g.current_question) * interval '1 second') else null end,
    'answer_phase_started', g.status = 'question'
      and clock_timestamp() >= g.question_started_at + interval '15 seconds',
    'answer_revealed', v_answer_revealed,
    'scoreboard_revealed', g.scoreboard_revealed,
    'answered_count', v_answered_count,
    'player_count', v_player_count,
    'correct_answers', case when v_answer_revealed then
      case when jsonb_typeof(q.questions -> g.current_question -> 'correctAnswers') = 'array'
        then q.questions -> g.current_question -> 'correctAnswers'
        else jsonb_build_array((q.questions -> g.current_question ->> 'correctAnswer')::integer) end
      else null end,
    'question', case when g.status = 'question' then
      jsonb_build_object(
        'prompt', q.questions -> g.current_question -> 'prompt',
        'answer_type', coalesce(q.questions -> g.current_question ->> 'answerType', 'multiple-choice'),
        'allow_multiple_answers', case
          when coalesce(q.questions -> g.current_question ->> 'answerType', 'multiple-choice') = 'text' then false
          when jsonb_typeof(q.questions -> g.current_question -> 'correctAnswers') = 'array'
            then jsonb_array_length(q.questions -> g.current_question -> 'correctAnswers') > 1
          else false
        end,
        'answers', case
          when coalesce(q.questions -> g.current_question ->> 'answerType', 'multiple-choice') = 'text'
            then case when v_answer_revealed then q.questions -> g.current_question -> 'answers' else '[]'::jsonb end
          when clock_timestamp() >= g.question_started_at + interval '15 seconds'
            then q.questions -> g.current_question -> 'answers'
          else '[]'::jsonb
        end
      )
      else null
    end,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.name, 'score', p.score) order by p.score desc, p.joined_at)
      from public.quiz_players p where p.game_id = g.id
    ), '[]'::jsonb)
  ) into v_result
  from public.quiz_games g
  join public.quizzes q on q.id = g.quiz_id
  where g.code = p_code;

  if v_result is null then
    raise exception 'Dieses Quiz wurde nicht gefunden.';
  end if;
  return v_result;
end;
$$;

create or replace function public.join_quiz_game(p_code text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.quiz_games%rowtype;
  v_player_id uuid;
  v_title text;
begin
  if length(trim(coalesce(p_name, ''))) not between 1 and 24 then
    raise exception 'Der Name muss zwischen 1 und 24 Zeichen lang sein.';
  end if;

  select * into v_game from public.quiz_games where code = p_code for update;
  if not found or v_game.status <> 'waiting' then
    raise exception 'Dieses Quiz wurde nicht gefunden oder ist bereits gestartet.';
  end if;

  select title into v_title from public.quizzes where id = v_game.quiz_id;
  insert into public.quiz_players (game_id, name)
  values (v_game.id, trim(p_name))
  returning id into v_player_id;

  return jsonb_build_object('player_id', v_player_id, 'title', v_title);
exception
  when unique_violation then
    raise exception 'Dieser Name ist in diesem Quiz bereits vergeben. Bitte wähle einen anderen.';
end;
$$;

create or replace function public.get_quiz_game_state(p_code text, p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.quiz_games%rowtype;
  v_quiz public.quizzes%rowtype;
  v_player public.quiz_players%rowtype;
  v_question jsonb;
  v_answer public.quiz_answers%rowtype;
  v_player_count integer;
  v_answered_count integer;
  v_answer_revealed boolean;
  v_time_limit integer;
  v_answer_phase_started boolean;
begin
  select * into v_game from public.quiz_games where code = p_code;
  if not found then
    raise exception 'Dieses Quiz wurde nicht gefunden.';
  end if;

  select * into v_player from public.quiz_players
  where id = p_player_id and game_id = v_game.id;
  if not found then
    raise exception 'Spieler nicht gefunden. Bitte tritt dem Quiz erneut bei.';
  end if;

  select * into v_quiz from public.quizzes where id = v_game.quiz_id;
  if v_game.status = 'question' then
    v_question := v_quiz.questions -> v_game.current_question;
    v_time_limit := coalesce((v_question ->> 'timeLimitSeconds')::integer, 30);
  end if;

  select * into v_answer from public.quiz_answers
  where player_id = v_player.id and question_index = v_game.current_question;

  select count(*) into v_player_count from public.quiz_players where game_id = v_game.id;
  select count(distinct player_id) into v_answered_count
  from public.quiz_answers
  where game_id = v_game.id and question_index = v_game.current_question;
  v_answer_phase_started := v_game.status = 'question'
    and clock_timestamp() >= coalesce(v_game.question_started_at, clock_timestamp()) + interval '15 seconds';
  v_answer_revealed := v_game.status = 'finished' or (v_game.status = 'question' and (
    v_answer_phase_started and (
      clock_timestamp() >= coalesce(v_game.question_started_at, clock_timestamp()) + interval '15 seconds'
        + (v_time_limit * interval '1 second')
      or (v_player_count > 0 and v_answered_count >= v_player_count)
    )
  ));

  return jsonb_build_object(
    'title', v_quiz.title,
    'status', v_game.status,
    'current_question', v_game.current_question,
    'question_count', jsonb_array_length(v_quiz.questions),
    'reading_deadline', case when v_game.status = 'question' then v_game.question_started_at + interval '15 seconds' else null end,
    'deadline', case when v_game.status = 'question' then v_game.question_started_at + interval '15 seconds'
      + (v_time_limit * interval '1 second') else null end,
    'answer_phase_started', v_answer_phase_started,
    'answer_revealed', v_answer_revealed,
    'answered_count', v_answered_count,
    'player_count', v_player_count,
    'correct_answers', case when v_answer_revealed then
      case when jsonb_typeof(v_question -> 'correctAnswers') = 'array' then v_question -> 'correctAnswers'
      else jsonb_build_array((v_question ->> 'correctAnswer')::integer) end
      else null end,
    'question', case when v_question is null then null else
      jsonb_build_object(
        'prompt', v_question -> 'prompt',
        'answer_type', coalesce(v_question ->> 'answerType', 'multiple-choice'),
        'allow_multiple_answers', case
          when coalesce(v_question ->> 'answerType', 'multiple-choice') = 'text' then false
          when jsonb_typeof(v_question -> 'correctAnswers') = 'array'
            then jsonb_array_length(v_question -> 'correctAnswers') > 1
          else false
        end,
        'answers', case
          when coalesce(v_question ->> 'answerType', 'multiple-choice') = 'text'
            then case when v_answer_revealed then v_question -> 'answers' else '[]'::jsonb end
          when v_answer_phase_started then v_question -> 'answers'
          else '[]'::jsonb
        end
      ) end,
    'score', v_player.score - case
      when not v_answer_revealed and v_answer.id is not null then coalesce(v_answer.points_earned, 0)
      else 0
    end,
    'points_earned', case when v_answer_revealed then coalesce(v_answer.points_earned, 0) else 0 end,
    'has_answered', v_answer.id is not null,
    'is_correct', case when v_answer_revealed and v_answer.id is not null then v_answer.is_correct else null end,
    'leaderboard', case when v_game.status = 'finished' then coalesce((
      select jsonb_agg(jsonb_build_object('name', p.name, 'score', p.score) order by p.score desc, p.joined_at)
      from public.quiz_players p where p.game_id = v_game.id
    ), '[]'::jsonb) else null end
  );
end;
$$;

create or replace function public.submit_quiz_answer(p_code text, p_player_id uuid, p_answer_indices integer[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.quiz_games%rowtype;
  v_quiz public.quizzes%rowtype;
  v_player public.quiz_players%rowtype;
  v_question jsonb;
  v_correct_answers jsonb;
  v_submitted integer[];
  v_expected integer[];
  v_correct boolean;
  v_points integer := 0;
  v_base_points integer;
  v_elapsed_seconds numeric;
  v_answer_points integer := 0;
  v_player_count integer;
  v_answered_count integer;
  v_time_limit integer;
  v_answer_started_at timestamptz;
begin
  select * into v_game from public.quiz_games where code = p_code for update;
  if not found or v_game.status <> 'question' then
    raise exception 'Gerade ist keine Frage geöffnet.';
  end if;

  select * into v_player from public.quiz_players
  where id = p_player_id and game_id = v_game.id;
  if not found then
    raise exception 'Spieler nicht gefunden. Bitte tritt dem Quiz erneut bei.';
  end if;

  select * into v_quiz from public.quizzes where id = v_game.quiz_id;
  v_question := v_quiz.questions -> v_game.current_question;
  if coalesce(v_question ->> 'answerType', 'multiple-choice') <> 'multiple-choice' then
    raise exception 'Diese Frage erwartet eine Texteingabe.';
  end if;
  v_time_limit := coalesce((v_question ->> 'timeLimitSeconds')::integer, 30);
  v_answer_started_at := v_game.question_started_at + interval '15 seconds';
  if jsonb_typeof(v_question -> 'correctAnswers') = 'array' then
    v_correct_answers := v_question -> 'correctAnswers';
  else
    v_correct_answers := jsonb_build_array((v_question ->> 'correctAnswer')::integer);
  end if;

  if coalesce(cardinality(p_answer_indices), 0) = 0 then
    raise exception 'Wähle mindestens eine Antwort aus.';
  end if;

  select array_agg(distinct selected.answer_index order by selected.answer_index)
  into v_submitted
  from unnest(p_answer_indices) as selected(answer_index);

  if cardinality(v_submitted) <> cardinality(p_answer_indices)
    or exists (
      select 1 from unnest(v_submitted) as selected(answer_index)
      where selected.answer_index < 0
        or selected.answer_index >= jsonb_array_length(v_question -> 'answers')
    ) then
    raise exception 'Eine ausgewählte Antwort gibt es bei dieser Frage nicht.';
  end if;

  select array_agg(correct.value::integer order by correct.value::integer)
  into v_expected
  from jsonb_array_elements_text(v_correct_answers) as correct(value);
  v_correct := v_submitted = v_expected;

  if v_correct then
    case coalesce(v_question ->> 'scoringMode', 'normal')
      when 'normal' then v_base_points := 1000;
      when 'double' then v_base_points := 2000;
      when 'none' then v_base_points := 0;
      else raise exception 'Die Punktewertung dieser Frage ist ungültig.';
    end case;
    v_elapsed_seconds := greatest(
      0,
      extract(epoch from (clock_timestamp() - v_answer_started_at))
    );
    v_points := floor(
      v_base_points * greatest(0.5, 1 - least(v_elapsed_seconds, v_time_limit) / (v_time_limit * 2.0))
    );
  end if;

  if exists (
    select 1 from public.quiz_answers
    where player_id = v_player.id and question_index = v_game.current_question
  ) then
    select bool_and(is_correct) into v_correct
    from public.quiz_answers
    where player_id = v_player.id and question_index = v_game.current_question;
    select max(points_earned) into v_answer_points
    from public.quiz_answers
    where player_id = v_player.id and question_index = v_game.current_question;
    select * into v_player from public.quiz_players where id = v_player.id;
    return jsonb_build_object('submitted', true);
  end if;

  if clock_timestamp() < v_answer_started_at then
    raise exception 'Bitte lies zuerst die Frage. Die Antwortmöglichkeiten erscheinen gleich.';
  end if;
  if clock_timestamp() >= v_answer_started_at + (v_time_limit * interval '1 second') then
    raise exception 'Die Antwortzeit ist abgelaufen.';
  end if;
  select count(*) into v_player_count from public.quiz_players where game_id = v_game.id;
  select count(distinct player_id) into v_answered_count
  from public.quiz_answers
  where game_id = v_game.id and question_index = v_game.current_question;
  if v_player_count > 0 and v_answered_count >= v_player_count then
    raise exception 'Alle Spieler haben bereits geantwortet.';
  end if;

  insert into public.quiz_answers (game_id, player_id, question_index, answer_index, is_correct, points_earned)
  select v_game.id, v_player.id, v_game.current_question, selected.answer_index, v_correct, v_points
  from unnest(v_submitted) as selected(answer_index);

  if v_correct and v_points > 0 then
    update public.quiz_players set score = score + v_points where id = v_player.id;
  end if;

  select * into v_player from public.quiz_players where id = p_player_id;
  return jsonb_build_object('submitted', true);
end;
$$;

create or replace function public.submit_quiz_text_answer(p_code text, p_player_id uuid, p_answer_text text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.quiz_games%rowtype;
  v_quiz public.quizzes%rowtype;
  v_player public.quiz_players%rowtype;
  v_question jsonb;
  v_correct boolean;
  v_points integer := 0;
  v_base_points integer;
  v_elapsed_seconds numeric;
  v_time_limit integer;
  v_answer_started_at timestamptz;
  v_answer_points integer;
begin
  select * into v_game from public.quiz_games where code = p_code for update;
  if not found or v_game.status <> 'question' then
    raise exception 'Gerade ist keine Frage geöffnet.';
  end if;

  select * into v_player from public.quiz_players
  where id = p_player_id and game_id = v_game.id;
  if not found then
    raise exception 'Spieler nicht gefunden. Bitte tritt dem Quiz erneut bei.';
  end if;

  if length(btrim(coalesce(p_answer_text, ''))) not between 1 and 120 then
    raise exception 'Die Antwort muss zwischen 1 und 120 Zeichen lang sein.';
  end if;

  if exists (
    select 1 from public.quiz_answers
    where player_id = v_player.id and question_index = v_game.current_question
  ) then
    select bool_and(is_correct), max(points_earned)
    into v_correct, v_answer_points
    from public.quiz_answers
    where player_id = v_player.id and question_index = v_game.current_question;
    select * into v_player from public.quiz_players where id = v_player.id;
    return jsonb_build_object('submitted', true);
  end if;

  v_time_limit := public.quiz_question_time_limit(v_game.id, v_game.current_question);
  v_answer_started_at := v_game.question_started_at + interval '15 seconds';
  if clock_timestamp() < v_answer_started_at then
    raise exception 'Bitte lies zuerst die Frage. Die Texteingabe erscheint gleich.';
  end if;
  if clock_timestamp() >= v_answer_started_at + (v_time_limit * interval '1 second') then
    raise exception 'Die Antwortzeit ist abgelaufen.';
  end if;

  select * into v_quiz from public.quizzes where id = v_game.quiz_id;
  v_question := v_quiz.questions -> v_game.current_question;
  if coalesce(v_question ->> 'answerType', 'multiple-choice') <> 'text' then
    raise exception 'Diese Frage erwartet die Auswahl einer Antwort.';
  end if;

  select exists (
    select 1
    from jsonb_array_elements_text(v_question -> 'answers') as accepted(value)
    where lower(btrim(accepted.value)) = lower(btrim(p_answer_text))
  ) into v_correct;

  if v_correct then
    case coalesce(v_question ->> 'scoringMode', 'normal')
      when 'normal' then v_base_points := 1000;
      when 'double' then v_base_points := 2000;
      when 'none' then v_base_points := 0;
      else raise exception 'Die Punktewertung dieser Frage ist ungültig.';
    end case;
    v_elapsed_seconds := greatest(0, extract(epoch from (clock_timestamp() - v_answer_started_at)));
    v_points := floor(
      v_base_points * greatest(0.5, 1 - least(v_elapsed_seconds, v_time_limit) / (v_time_limit * 2.0))
    );
  end if;

  insert into public.quiz_answers (game_id, player_id, question_index, answer_index, is_correct, points_earned)
  values (v_game.id, v_player.id, v_game.current_question, 0, v_correct, v_points);
  if v_correct and v_points > 0 then
    update public.quiz_players set score = score + v_points where id = v_player.id;
  end if;

  select * into v_player from public.quiz_players where id = v_player.id;
  return jsonb_build_object('submitted', true);
end;
$$;

revoke all on function public.start_quiz_game(uuid) from public;
revoke all on function public.quiz_question_time_limit(uuid, integer) from public;
revoke all on function public.advance_quiz_game(text) from public;
revoke all on function public.get_teacher_game_state(text) from public;
revoke all on function public.get_public_quiz_display(text) from public;
revoke all on function public.join_quiz_game(text, text) from public;
revoke all on function public.get_quiz_game_state(text, uuid) from public;
revoke all on function public.submit_quiz_answer(text, uuid, integer[]) from public;
revoke all on function public.submit_quiz_text_answer(text, uuid, text) from public;

grant execute on function public.start_quiz_game(uuid) to authenticated;
grant execute on function public.advance_quiz_game(text) to authenticated;
grant execute on function public.get_teacher_game_state(text) to authenticated;
grant execute on function public.get_public_quiz_display(text) to anon, authenticated;
grant execute on function public.join_quiz_game(text, text) to anon, authenticated;
grant execute on function public.get_quiz_game_state(text, uuid) to anon, authenticated;
grant execute on function public.submit_quiz_answer(text, uuid, integer[]) to anon, authenticated;
grant execute on function public.submit_quiz_text_answer(text, uuid, text) to anon, authenticated;
