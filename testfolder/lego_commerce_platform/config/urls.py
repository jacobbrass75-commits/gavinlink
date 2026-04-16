from django.contrib import admin
from django.http import JsonResponse
from django.urls import path


def healthz(_request):
    return JsonResponse({"status": "ok", "service": "lego-commerce-platform"})


urlpatterns = [
    path("healthz/", healthz, name="healthz"),
    path("admin/", admin.site.urls),
]
