# Instrukcja dla agenta EA

Adres routera to `https://gai-routuer.wowk-digital.workers.dev`. Przechowuj dane dostępowe w sekretach środowiska agenta. Do wywołań modeli używaj `ROUTER_APP_TOKEN`, a do konfiguracji `ROUTER_CONFIG_TOKEN`. Administrator generuje token konfiguracji w panelu w sekcji **Bezpieczeństwo → API konfiguracji**. Token jest widoczny po utworzeniu, wygasa po 90 dniach i można go unieważnić. Utworzenie nowego tokena zastępuje poprzedni.

## Wywoływanie Gemini

Używaj identyfikatora modelu Gemini API i wysyłaj żądania w formacie Google. Router wybiera projekt i klucz Google na podstawie tokena aplikacji.

```sh
export ROUTER_URL=https://gai-routuer.wowk-digital.workers.dev
curl -fsS "$ROUTER_URL/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "Authorization: Bearer $ROUTER_APP_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"contents":[{"parts":[{"text":"Podsumuj dane wejściowe."}]}]}'
```

Do strumieniowania użyj `:streamGenerateContent?alt=sse`, a do liczenia tokenów `:countTokens`. Możesz też przekazać token aplikacji jako `x-goog-api-key`. Router zwraca identyfikator diagnostyczny w nagłówku `X-Request-Id`.

Jeśli Google zwróci 429, zastosuj `Retry-After`, gdy jest dostępny, i ogranicz kolejne próby. Limity dzienne dotyczą projektu i modelu. Inny klucz w tym samym projekcie korzysta z tej samej puli. Doba zaczyna się o północy czasu pacyficznego. Cache routera omija wywołanie Google. [Limity Gemini API](https://ai.google.dev/gemini-api/docs/rate-limits)

## Zdalna konfiguracja

Każde żądanie do `/config/v1` wymaga nagłówka `Authorization: Bearer $ROUTER_CONFIG_TOKEN`. Operacje zapisu przyjmują JSON.

| Metoda i ścieżka | Zastosowanie | Pola |
| --- | --- | --- |
| `GET /config/v1` | Odczytaj projekty, metadane kluczy, aplikacje, limity zapisane w projekcie i liczniki routera | — |
| `POST /config/v1/projects` | Dodaj projekt | `project_id`, `name` |
| `POST /config/v1/keys` | Dodaj klucz Google i przełącz ruch projektu na ten klucz | `project_id`, `api_key`, opcjonalnie `label` i `create_project: true` |
| `POST /config/v1/apps` | Utwórz aplikację i odbierz jej token | `project_id`, `name`, opcjonalnie `cache_seconds`, `log_bodies` |
| `PATCH /config/v1/apps/{id}` | Ustaw cache i zapis treści dla aplikacji | `cache_seconds` od 0 do 86400, `log_bodies` jako wartość logiczna |
| `POST /config/v1/quotas` | Zapisz komplet limitów dla modelu w projekcie | `project_id`, `model`, `rpm`, `tpm`, `rpd`. Wartość `null` czyści własny limit danego pola. |

```sh
curl -fsS "$ROUTER_URL/config/v1" \
  -H "Authorization: Bearer $ROUTER_CONFIG_TOKEN"

curl -fsS "$ROUTER_URL/config/v1/quotas" \
  -H "Authorization: Bearer $ROUTER_CONFIG_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"project_id":"moj-projekt-gemini","model":"gemini-2.5-flash","rpm":5,"tpm":250000,"rpd":20}'
```

Odczytaj konfigurację przed zmianą. Jeśli dodawanie aplikacji lub klucza przerwie się bez odpowiedzi, sprawdź stan przez GET przed ponowieniem. Token nowej aplikacji jest dostępny w odpowiedzi na utworzenie aplikacji. Zapisz go bez wypisywania w logach. Wartości zapisanych kluczy Google, historia żądań i zarządzanie sesjami pozostają poza zakresem tokena konfiguracji.

W odpowiedzi GET pole `usage` zawiera pomiar ruchu przez router, a `quotas` zawiera własne limity projektu. Dla zapisanych limitów `remaining_rpd` pokazuje szacowany zapas. Przy wartościach referencyjnych z katalogu odejmij `used_rpd` dla pary projektu i modelu, a wynik ogranicz do minimum zero. Ruch poza routerem może zmniejszać rzeczywisty zapas.
