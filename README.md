# Gemini Router

Aplikacje wysyłają zapytania do Cloudflare Workera, podając własny token routera. Worker wybiera projekt przypisany do aplikacji, wywołuje Gemini Developer API kluczem tego projektu i zwraca odpowiedź. D1 przechowuje konfigurację, cache i historię. Statyczny panel w katalogu `docs/` komunikuje się z API Workera.

## Co obejmuje ta wersja

- Projekty Google Cloud, klucze typu **Auth key** z AI Studio i osobne tokeny aplikacji. Klucze Google są szyfrowane w D1 przy użyciu AES-GCM. Tokeny aplikacji są losowe, wyświetlane raz i zapisywane w postaci skrótu. Administrator może obrócić token aplikacji bez utraty jej historii albo go unieważnić.
- Router udostępnia metody `generateContent`, `streamGenerateContent` (SSE) i `countTokens` pod ścieżkami `/v1beta/models/…` i `/v1/models/…`. Obsługiwane są wersje i modele, które Google udostępnia pod wybraną ścieżką.
- Worker używa najnowszego aktywnego klucza przypisanego do projektu. Dodanie klucza przełącza nowe wywołania Google. Wyłączenie klucza w panelu usuwa jego zaszyfrowaną wartość z bieżącej bazy i przywraca poprzedni aktywny klucz, jeśli istnieje. Unieważnieniem klucza po stronie Google zarządza się w AI Studio.
- Statystyki z ostatnich 24 godzin pokazują liczbę poprawnie uwierzytelnionych żądań generacji i liczenia tokenów, prób wysłania do Google, trafień cache, błędów i tokenów zaraportowanych przez Google. Historia pokazuje ostatnie 100 żądań wraz z czasem, modelem, statusem i identyfikatorem.
- Limity RPM, TPM wejściowe i RPD wpisuje się dla projektu i modelu na podstawie AI Studio. RPM i TPM obejmują ostatnie 60 sekund według zegara routera. RPD obejmuje okres od północy w strefie `America/Los_Angeles`. Zapas to estymacja na podstawie prób generacji przez router. Ruch poza routerem i ograniczenia wydatków nie są uwzględniane. TPM ma stan „brak estymacji”, jeśli dla któregoś wywołania z ostatniej minuty brakuje danych o tokenach. Worker przekazuje odpowiedzi Google 429 i nagłówek `Retry-After`, jeżeli Google go zwróci. Lokalne liczniki są informacyjne.
- Cache i zapisywanie treści są domyślnie wyłączone i konfigurowane osobno dla każdej aplikacji. TTL wynosi maksymalnie 24 godziny. Cache rozróżnia aplikację, projekt, wersję API, model oraz dokładną treść JSON. Zapisuje kompletne odpowiedzi 200 z `finishReason: STOP`, o rozmiarze do 256 KiB, na zwykłe wywołania `generateContent` bez narzędzi i `cachedContent`. Trafienie omija Google. Powtórzenie może zwrócić tę samą odpowiedź mimo losowości modelu.
- Historia przechowuje metadane przez 14 dni. Po włączeniu zapisu treści w D1 można odczytać żądanie i odpowiedź do 256 KiB każde przez 24 godziny. Większe treści są pomijane. Router przyjmuje żądania do 1 MiB i przekazuje odpowiedzi strumieniowo. Godzinny Cron sprząta dane w partiach. Treści debugowania i cache są przechowywane jako tekst w D1. Kopie Time Travel podlegają retencji Cloudflare.

[Dokumentacja kluczy Google](https://ai.google.dev/gemini-api/docs/api-key?authuser=2&hl=en) · [Limity Gemini](https://ai.google.dev/gemini-api/docs/rate-limits?authuser=2) · [Generowanie i SSE](https://ai.google.dev/api/generate-content?hl=en) · [Limity D1](https://developers.cloudflare.com/d1/platform/limits/)

## Panel i logowanie

Panel jest publikowany przez GitHub Actions na [GitHub Pages](https://wowkdigital.github.io/GAI-routuer/). Workflow buduje tylko pliki z `docs/`, lokalny skrypt WebAuthn i publiczny adres Workera z `panel.config.json`. Konfiguracja projektów, aplikacji, kluczy i limitów oraz dane WebAuthn, cache i historia znajdują się w D1.

1. Otwórz panel w zwykłej karcie przeglądarki.
2. Przy pierwszym uruchomieniu wprowadź otrzymany jednorazowy kod i zarejestruj klucz dostępu (passkey). Przeglądarka poprosi o potwierdzenie przez Windows Hello, telefon, klucz sprzętowy lub zgodny menedżer kluczy dostępu.
3. Do kolejnych logowań wystarczy zarejestrowany klucz. Sesja wygasa po 30 minutach lub przy wylogowaniu. Odświeżenie karty usuwa token z jej pamięci.
4. Jeśli chcesz logować się także hasłem, po zalogowaniu kluczem dostępu otwórz sekcję **Logowanie hasłem** i ustaw hasło mające co najmniej 16 znaków. Po wylogowaniu pojawi się drugi formularz logowania. Zmiana lub wyłączenie hasła wymaga sesji uzyskanej przez passkey i kończy wszystkie dotychczasowe sesje hasłowe.

Worker weryfikuje podpis WebAuthn, origin, RP ID oraz obecność weryfikacji użytkownika. Wyzwanie jest jednorazowe i ważne przez 5 minut. Po rejestracji pierwszego administratora kolejne rejestracje są blokowane. W D1 przechowywany jest klucz publiczny i skróty losowych tokenów sesji. Panel trzyma token sesji w pamięci karty. Adres `wowkdigital.github.io` jest wspólnym originem stron GitHub Pages tego konta, więc publikowane na nim aplikacje powinny być zaufane.

Przeglądarka wyprowadza wartość hasła przez PBKDF2-HMAC-SHA-256 (600 000 iteracji, losowa sól). Worker wylicza z niej weryfikator HMAC z odrębnym sekretem `PASSWORD_PEPPER` i zapisuje w D1 tylko sól i weryfikator. Próby weryfikacji są ograniczone do pięciu na minutę na adres IP w każdej lokalizacji Cloudflare.

[SimpleWebAuthn](https://simplewebauthn.dev/docs/packages/server) · [GitHub Pages przez Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

## Uruchomienie lokalne

Przykłady dla PowerShell 7. Użyj Node 24.22.0 lub nowszego wydania z linii 24. Przypięty `cf` obsługuje także Node 22 od 22.23 i Node 26 od 26.12.

```powershell
npm ci
npm test
npm run build:panel -- --local
$env:ROUTER_D1_ID = '00000000-0000-4000-8000-000000000001'
npx cf d1 migrations apply $env:ROUTER_D1_ID --local --persist-to .cloudflare/state
```

Przy pierwszym uruchomieniu wygeneruj prywatny plik `.dev.vars` i zapisz kod rejestracji wyświetlony w terminalu.

```powershell
$code = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::ASCII.GetBytes($code))).ToLowerInvariant()
$expiry = [DateTimeOffset]::UtcNow.AddHours(24).ToUnixTimeMilliseconds()
$key = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$pepper = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
@("ADMIN_ENROLLMENT=$digest.$expiry", "KEY_ENCRYPTION_KEY=$key", "PASSWORD_PEPPER=$pepper") |
  Set-Content -Encoding utf8NoBOM .dev.vars
$code
npm run dev
```

W drugim terminalu uruchom `python -m http.server 8080 --directory panel-dist`. Otwórz `http://localhost:8080` i zarejestruj klucz testowy. Zachowaj tę samą wartość `KEY_ENCRYPTION_KEY` przy ponownym uruchomieniu lokalnym.

## Aktualizacja Workera i D1

1. Zaloguj się przez `npx cf auth login`. W Cloudflare wybierz istniejącego Workera i bazę `gai-routuer`. Odczytaj UUID bazy D1 z panelu Cloudflare.
2. Ustaw identyfikator bazy i origin panelu. Zastosuj migracje przed wdrożeniem Workera.

   ```powershell
   $env:ROUTER_D1_ID = '<UUID istniejącej bazy D1>'
   $env:ROUTER_PANEL_ORIGIN = 'https://wowkdigital.github.io'
   npx cf d1 migrations apply $env:ROUTER_D1_ID
   npx cf deploy --dry-run
   npx cf deploy
   ```

3. Przy pierwszym wdrożeniu utwórz oddzielne wartości produkcyjne w formacie `.dev.vars` opisanym wyżej i wgraj je przez `npx cf deploy --secrets-file .env.production.secrets`. Kod pierwszej rejestracji przekaż administratorowi prywatnie. Zachowaj `KEY_ENCRYPTION_KEY` w menedżerze sekretów. Zmiana tego klucza uniemożliwi odczyt istniejących kluczy Google.
4. Jeśli zmieni się publiczny adres Workera, zaktualizuj `panel.config.json` i wypchnij zmianę do `main`. GitHub Actions zbuduje i opublikuje panel ponownie.

Odzyskanie dostępu po utracie passkey wymaga dostępu administracyjnego do Cloudflare. Wygeneruj nowy kod i zaktualizuj wyłącznie sekret `ADMIN_ENROLLMENT`. Następnie usuń w jednej transakcji rekordy z `admin_passkey`, `admin_sessions`, `admin_challenges` i `admin_password`. Zarejestruj nowy klucz przez panel. Operacja zachowuje konfigurację projektów i dane aplikacji.

[Cloudflare CLI](https://developers.cloudflare.com/cf/projects/) · [Sekrety Workera](https://developers.cloudflare.com/workers/configuration/secrets/)
## Wywołanie z aplikacji

Przechowuj token routera po stronie serwera aplikacji. Zastąp `ROUTER_URL` adresem Workera, a `GEMINI_MODEL` modelem dostępnym w Twoim projekcie.

```powershell
$base = 'https://ROUTER_URL'
$model = 'GEMINI_MODEL'
$headers = @{ 'x-goog-api-key' = $env:ROUTER_APP_TOKEN }
$body = @{ contents = @(@{ parts = @(@{ text = 'Napisz jedno zdanie po polsku.' }) }) } |
  ConvertTo-Json -Depth 8 -Compress
$response = Invoke-WebRequest -Method Post -Uri "$base/v1beta/models/${model}:generateContent" `
  -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body
$response.Content
$response.Headers['X-Router-Cache']
$response.Headers['X-Request-Id']
```

Możesz też wysłać `Authorization: Bearer <token-routera>`. Przy strumieniowaniu użyj `:streamGenerateContent?alt=sse`. Panel pozwala odszukać identyfikator z `X-Request-Id`. Testy `npm test` uruchamiają kod Workera z lokalnym SQLite i symulowanym Google API.
