# nodebb-plugin-topic-icons

Ikony tematów dla **NodeBB 4.x**. Przy tworzeniu tematu autor wybiera ikonę z biblioteki
prowadzonej przez administratorów; ikona pojawia się przy temacie na listach tematów i w nagłówku
tematu.

*English version: [README.md](README.md).*

- **Zgodność:** NodeBB `^4.0.0`, testowane z NodeBB 4.16, nodebb-plugin-composer-default 11 i motywem
  Harmony; Node.js 22 lub nowszy.
- **Autor:** [nairda](https://wirelab.pl) · **Licencja:** MIT

## Zrzuty ekranu

![Lista tematów: ikona tematu w miejscu awatara, awatar autora jako mała nakładka](https://raw.githubusercontent.com/nairdaweb/nodebb-plugin-topic-icons/main/docs/screenshot-list.png)

![Okno wyboru ikony w edytorze z podglądem wiersza tematu](https://raw.githubusercontent.com/nairdaweb/nodebb-plugin-topic-icons/main/docs/screenshot-picker.png)

*Na zrzutach własny motyw (nodebb-theme-wirelab), który wstawia ikonę w miejsce awatara; w Harmony ikona pojawia się przed tytułem.*

## Funkcje

- **Wybór w edytorze:** przycisk „Wybierz miniaturę” obok tytułu otwiera siatkę ikon dostępnych
  w wybranej kategorii, z podglądem wiersza tematu. Ikonę można zmienić przy edycji pierwszego posta.
- **Biblioteka w ACP:** wgrywanie (PNG, WebP, SVG do 256 KB), zmiana nazwy, kolejność, przypisanie do
  kategorii, wyłączanie, usuwanie. Osiem neutralnych ikon wbudowanych: pytanie, poradnik, problem,
  pomysł, projekt, pokaz, ogłoszenie, dyskusja.
- **Zestawy i domyślne ikony kategorii:** ikonę można ograniczyć do wybranych kategorii; każda
  kategoria może mieć ikonę domyślną (jest też domyślna dla całego forum).
- **Uprawnienia:** wszyscy, którzy mogą tworzyć tematy, członkowie jednej grupy albo tylko
  moderatorzy. Użytkownicy wybierają tylko z biblioteki, nie wgrywają własnych plików.
- **Walidacja na serwerze:** ikona musi istnieć, być aktywna, dostępna w kategorii, a użytkownik musi
  mieć prawo wyboru; zmienić ją może tylko autor tematu albo moderator.
- **Język widza** w nazwach ikon (pełne ładowanie, ajaxify, API); `alt` i podpowiedź zawierają nazwę.
- **Bez własnych tabel:** biblioteka w ustawieniach wtyczki, wybrana ikona w obiekcie tematu
  (`topic:<tid>` → `iconId`); działa z Redis, MongoDB i PostgreSQL.
- **Wydajność:** biblioteka w pamięci (unieważniana przy zapisie, także między procesami przez
  pubsub), gotowy HTML w pamięci LRU, listy tematów bez dodatkowych zapytań.

## Instalacja

```sh
cd /ścieżka/do/nodebb
npm install nodebb-plugin-topic-icons
./nodebb activate nodebb-plugin-topic-icons
./nodebb build
./nodebb restart
```

Konfiguracja: **ACP → Wtyczki → Ikony tematów**.

## Dla autorów motywów

Tematy na listach i strona tematu mają pole `topicIcon` (`id`, `name`, `url`, `isDefault`, `html`).
`html` jest budowany na serwerze z escapowaną nazwą (`[` i `]` jako `&lsqb;` / `&rsqb;`), więc można
go wstawić bez escapowania, np. w `partials/topics_list.tpl`:

```html
{{{ if ./topicIcon }}}{{./topicIcon.html}}{{{ end }}}
```

Motywy bez takiego miejsca dostają ikonę przed tytułem tematu z `public/client.js`. Rozmiary to
zmienne CSS: `--topic-icon-size`, `--topic-icon-size-header`, `--topic-icon-size-inline`,
`--topic-icon-radius`. Szczegóły API: [README.md](README.md#api).

## Licencja

MIT, zob. [LICENSE](LICENSE). Wbudowane ikony w `static/icons/` są częścią pakietu i mają tę samą
licencję.
