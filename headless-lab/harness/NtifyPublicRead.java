import com.google.gson.*;
import com.spotifyxp.spotapi.SpotAPI;
import com.spotifyxp.spotapi.pojos.SearchResponse;
import com.spotifyxp.spotapi.pojos.UserInfo;
import okhttp3.*;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** Public reads only. Anonymous guest tokens arrive on stdin and are never logged. */
public final class NtifyPublicRead {
    public static void main(String[] args) throws Exception {
        Gson gson = new Gson();
        JsonObject auth = JsonParser.parseString(new BufferedReader(
            new InputStreamReader(System.in, StandardCharsets.UTF_8)).readLine()).getAsJsonObject();
        List<Map<String, Object>> requests = new ArrayList<>();
        OkHttpClient http = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).callTimeout(25, TimeUnit.SECONDS)
            .addInterceptor(chain -> {
                Map<String, Object> attempt = new LinkedHashMap<>();
                attempt.put("host", chain.request().url().host());
                attempt.put("path", chain.request().url().encodedPath());
                requests.add(attempt);
                Response response = chain.proceed(chain.request());
                attempt.put("http_status", response.code());
                return response;
            }).build();
        SpotAPI api = new SpotAPI.Builder().setToken(auth.get("access_token").getAsString())
            .setClientToken(auth.get("client_token").getAsString())
            .setAppPlatform("WebPlayer").setUserAgent(auth.get("user_agent").getAsString())
            .setSpotifyClientHost("spclient.wg.spotify.com")
            .setUserInfo(new UserInfo("anonymous", "BR", "FREE")).setHttpClient(http).build();
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("candidate", "ntify-spotapi");
        report.put("mode", "live_public_search_with_guest_tokens");
        report.put("authenticated_account", false);
        try {
            SearchResponse search = api.feed().search().setSearchTerm("Miles Davis").setLimit(1).execute();
            JsonObject page = gson.toJsonTree(search).getAsJsonObject().getAsJsonObject("tracksV2");
            int count = page != null && page.has("items") ? page.getAsJsonArray("items").size() : 0;
            report.put("tracks_returned", count);
            report.put("status", count > 0 ? "passed" : "failed");
        } catch (Exception error) {
            report.put("status", "failed");
            report.put("error_type", error.getClass().getSimpleName());
            String message = String.valueOf(error.getMessage());
            for (String code : Arrays.asList("PersistedQueryNotFound", "UNAUTHENTICATED", "Unauthorized", "HTTP 401", "HTTP 403", "HTTP 429")) {
                if (message.contains(code)) report.put("error_category", code);
            }
        }
        report.put("http_attempts", requests);
        http.dispatcher().executorService().shutdown();
        http.connectionPool().evictAll();
        System.out.println(gson.toJson(report));
    }
}
