TELEPORADA 1.1.0
Aplikacja teleporady wideo z automatycznym protokołem i podsumowaniem wizyty

Uruchomienie od zera

1. Zainstaluj Node.js 22 w wersji 22.13.0 lub nowszej w tej linii oraz
   aktualną przeglądarkę Chrome lub Edge. Przygotuj kamerę i mikrofon.
2. Otwórz terminal w katalogu 02_Aplikacja_kod. Sprawdź node --version.
3. Uruchom node server.mjs. Instalowanie pakietów npm jest zbędne.
   Przy pierwszym starcie serwer sam tworzy data/teleporada.sqlite,
   cztery konta demonstracyjne i jedną oczekującą wizytę.
4. Otwórz http://localhost:3000. Dla dwóch ról użyj osobnych profili
   przeglądarki, dwóch przeglądarek lub okna zwykłego i prywatnego.
5. Zaloguj się kontami demonstracyjnymi. Używaj wyłącznie fikcyjnych danych.

   Rola                 Login       Hasło
   Lekarz               lekarz      DemoLekarz!2026
   Pacjent              pacjent     DemoPacjent!2026
   Pacjent bez wizyty   pacjent2    DemoPacjent2!2026
   Operator audytu      audyt       DemoAudyt!2026

Podsumowanie AI

1. Zainstaluj Ollama z https://ollama.com/download i uruchom ją lokalnie.
   Aplikacja używa adresu http://127.0.0.1:11434. Jeśli Ollama nie działa
   w tle, uruchom ollama serve w osobnym terminalu.
2. Pobierz lokalny model poleceniem ollama pull qwen3:1.7b (około 1,4 GB).
   Uruchom lub zostaw uruchomiony serwer aplikacji z punktu 3 powyżej.
3. Podczas wizyty wpisz notatkę w sekcji „Plan” lub dodaj przykładowe notatki.
   Po „Zakończ wizytę” model przygotuje polski szkic podsumowania.
   Lekarz porównuje go z planem, poprawia treść i zatwierdza podsumowanie.

Do lokalnego modelu trafia tekst planu. Aplikacja nie przesyła nagrań,
wywiadu ani danych konta. Używaj wyłącznie fikcyjnych notatek. Dla instalacji
bez funkcji chmurowych uruchom Ollama z OLLAMA_NO_CLOUD=1.
Limit to 6500 znaków planu i 90 sekund na generowanie. Gdy model jest
niedostępny, pozostaje edytowalny szkic z planu. Po uruchomieniu Ollama
wybierz „Wygeneruj z planu”, żeby ponowić próbę bez nowej wizyty.
Opcjonalne ustawienia aplikacji to AI_SUMMARY_MODEL (domyślnie qwen3:1.7b,
wartość off wyłącza AI) oraz AI_SUMMARY_PORT (domyślnie 11434).

Demonstracja

1. Lekarz otwiera „Wizytę kontrolną” z listy i wybiera „Otwórz pokój wideo”.
   Pacjent otwiera swoją wizytę. Jeśli widzi poczekalnię, odświeża status.
2. Obie strony wybierają „Dołącz do rozmowy” i zezwalają na kamerę oraz
   mikrofon. Na wspólnym komputerze korzystaj ze słuchawek lub wycisz
   mikrofony po teście. Przy zajętej kamerze użyj osobnego urządzenia
   w środowisku HTTPS albo wirtualnych urządzeń testowych.
3. Lekarz wpisuje notatki w sekcjach SOAP lub dodaje przykładowe notatki.
   „Dyktuj” zależy od lokalnego rozpoznawania polskiej mowy w przeglądarce.
   Wariant ręczny działa niezależnie od rozpoznawania mowy.
4. „Zakończ wizytę” rozłącza media i tworzy szkic SOAP. Lokalny model
   przygotowuje podsumowanie z planu. Lekarz sprawdza wynik, koryguje
   treść, a następnie wybiera „Zapisz i zatwierdź”.
5. Pacjent odświeża status, czyta podsumowanie i może zapisać je jako PDF
   przez okno wydruku. Lekarz może pobrać demonstracyjny eksport FHIR JSON.
6. Konto audyt pokazuje metadane operacji. Konto pacjent2 służy do sprawdzenia
   izolacji: skopiowany adres wizyty innego pacjenta daje komunikat o braku dostępu.

Testy i przechowywanie danych

W 02_Aplikacja_kod wykonaj node --test. Testy tworzą odrębną bazę tymczasową.
Ctrl+C zatrzymuje serwer. Kolejny start zachowuje zapisane wizyty.
Aby rozpocząć z czystymi danymi, zatrzymaj serwer i zmień nazwę katalogu data.
Można też uruchomić serwer z DB_PATH wskazującym osobny plik bazy.

Konfiguracja demonstracji na innych urządzeniach

Domyślnie serwer nasłuchuje na 127.0.0.1:3000 i jest przeznaczony do testu
na jednym komputerze. Na osobnych urządzeniach udostępnij go przez zaufany
reverse proxy HTTPS. Ustaw APP_ORIGIN na dokładny publiczny adres HTTPS,
HOST na właściwy adres interfejsu lub sieci prywatnej, PORT na port serwera.
Proxy ma przekazywać Server-Sent Events bez buforowania. Dla oddzielnych sieci
podaj ICE_SERVERS jako tablicę JSON zgodną z RTCIceServer, z własnym STUN/TURN.
Ta konfiguracja wymaga sprawdzenia w sieci docelowej. Konta pozostają testowe.

Pliki

01_Dokumentacja       Dokumentacja w DOCX i PDF.
02_Aplikacja_kod      Serwer, interfejs, testy i openapi.json.
03_Aplikacja_uruchom  Skróty startowe Windows oraz Linux/macOS.
04_Dane_testowe       Przykładowy, syntetyczny eksport FHIR.
Załącznik B w dokumentacji zawiera formularze oświadczeń do weryfikacji.
