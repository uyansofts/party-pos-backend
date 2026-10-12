#!/usr/bin/env bash
# ============================================================================
# PG RACE CHECK — бодит PostgreSQL дээр "зэрэг ажиллах" үед манай дүрмүүд барьж байгааг шалгана.
# ----------------------------------------------------------------------------
# ЮУГ ШАЛГАХ ВЭ: Prisma `updateMany({ where: {... gte / status / null ...} })` нь PostgreSQL-д ЯГ ИЖИЛ
#   `UPDATE ... WHERE ...` болдог. Энд тэр SQL хэв маягийг НЭГ ЭРГЭЛТЭЭР олон холболтоор (psql) зэрэг ажиллуулж,
#   бодит DB-ийн мөрийн түгжээ + READ COMMITTED дахин шалгалт + advisory lock-ийг шалгана.
#   (fake-prisma нь эдгээрийг ДУУРАЙЖ байсан — энэ скрипт бодит байдлаар батална.)
# ЮУГ ШАЛГАХГҮЙ: манай TypeScript код, Prisma client өөрөө. Энэ нь зөвхөн DB-ийн хэв маяг.
# ЭРЧИМ ХАМГААЛАЛТ:
#   - ЗААВАЛ `ALLOW_THROWAWAY_DB=yes` өгөх ёстой, ХОЛБОГДОЖ БУЙ HOST-ийг эхэнд хэвлэнэ.
#   - Зөвхөн `diy_race_test` нэртэй ШИНЭ өгөгдлийн сан үүсгэнэ; аль хэдийн байвал ЮУ Ч хийхгүй зогсоно.
#   - Эцэст нь зөвхөн тэр DB-г устгана. Өөр DB, таны production-д огт хүрэхгүй.
#   - ХЭЗЭЭ Ч Supabase/production DB рүү заасан PGHOST-оор ажиллуулахгүй. Зөвхөн хоосон түр PostgreSQL (жишээ нь Docker).
# АЖИЛЛУУЛАХ (жишээ, Docker-ийн түр PostgreSQL):
#   docker run --rm -d --name pgrace -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16
#   export ALLOW_THROWAWAY_DB=yes PGHOST=localhost PGPORT=55432 PGUSER=postgres PGPASSWORD=x
#   bash tests/db-race/pg-race-check.sh
#   docker stop pgrace
# ============================================================================
set -u
if [ "${ALLOW_THROWAWAY_DB:-}" != "yes" ]; then echo "ALLOW_THROWAWAY_DB=yes өгөөгүй тул зогслоо"; exit 2; fi
: "${PGHOST:?PGHOST хэрэгтэй}"
PGPORT="${PGPORT:-5432}"; PGUSER="${PGUSER:-postgres}"
case "$PGHOST" in *supabase*|*pooler*|*amazonaws*|*render*|*neon*) echo "Алсын/production шиг HOST ($PGHOST) — зогслоо"; exit 2;; esac
export PGHOST PGPORT PGUSER
DB=diy_race_test
echo "Холбогдож буй: host=$PGHOST port=$PGPORT user=$PGUSER; үүсгэх DB=$DB"

ADMIN="psql -X -q -At -d postgres"
if [ "$($ADMIN -c "select 1 from pg_database where datname='$DB'")" = "1" ]; then echo "$DB аль хэдийн байна — зогслоо (хэнд ч хүрэхгүй)"; exit 2; fi
$ADMIN -c "create database $DB" >/dev/null || { echo "DB үүсгэж чадсангүй"; exit 2; }
cleanup() { $ADMIN -c "drop database if exists $DB" >/dev/null 2>&1; }
trap cleanup EXIT
P="psql -X -q -At -d $DB"

$P >/dev/null <<'SQL'
create table product (id text primary key, stock int not null);
create table orders (id text primary key, status text not null, courier text, assign text, seller_payout text, paid_at timestamptz);
create table material (id text primary key, stock_cm2 int not null);
create table rental (id serial primary key, product text not null, s date not null, e date not null);
SQL

PASS=0; FAIL=0
check() { # имя, хүлээгдсэн, бодит
  if [ "$2" = "$3" ]; then echo "  ✔ $1 (=$3)"; PASS=$((PASS+1)); else echo "  ✖ $1: хүлээсэн=$2 бодит=$3"; FAIL=$((FAIL+1)); fi
}
# n удаа зэрэг ажиллуулж, тус бүрийн ГАРСАН ТООГ (последняя мөр) нийлбэрлэнэ
par() { local n=$1 sql=$2 tmp; tmp=$(mktemp -d); for i in $(seq 1 "$n"); do ( $P -c "$sql" >"$tmp/$i" 2>"$tmp/$i.err" ) & done; wait; cat "$tmp"/? "$tmp"/?? 2>/dev/null | awk '{s+=$1} END{print s+0}'; rm -rf "$tmp"; }
val() { $P -c "$1"; }

echo "T1 Барааны нөөц: нөөц 4, 10 зэрэг хасалт (UPDATE ... WHERE stock >= 1)"
val "insert into product values ('p1',4)" >/dev/null
W=$(par 10 "select pg_sleep(0.05); with u as (update product set stock=stock-1 where id='p1' and stock>=1 returning 1) select count(*) from u")
check "яг 4 нь амжилттай" 4 "$W"; check "үлдэгдэл 0, сөрөг биш" 0 "$(val "select stock from product where id='p1'")"

echo "T1c (эсрэг шалгалт) нөөцийн хамгаалалтгүй хасалт сөрөг болгоно — шалгалт үнэхээр мэдэрдгийг харуулна"
val "insert into product values ('p2',4)" >/dev/null
par 10 "select pg_sleep(0.05); with u as (update product set stock=stock-1 where id='p2' returning 1) select count(*) from u" >/dev/null
check "хамгаалалтгүй үед нөөц сөрөг (-6)" -6 "$(val "select stock from product where id='p2'")"

echo "T2 Төлбөрийн claim: 8 зэрэг (WHERE status IN ('PENDING','PARTIALLY_PAID'))"
val "insert into orders(id,status) values ('o1','PENDING')" >/dev/null
W=$(par 8 "select pg_sleep(0.05); with u as (update orders set status='PAID', paid_at=now() where id='o1' and status in ('PENDING','PARTIALLY_PAID') returning 1) select count(*) from u")
check "яг 1 нь PAID болгоно" 1 "$W"

echo "T3 Курьер accept: 6 зэрэг (WHERE assign='OFFERED')"
val "insert into orders(id,status,assign) values ('d1','PAID','OFFERED')" >/dev/null
tmp=$(mktemp -d); for i in 1 2 3 4 5 6; do ( $P -c "select pg_sleep(0.05); with u as (update orders set courier='c$i', assign='ASSIGNED' where id='d1' and assign='OFFERED' returning 1) select count(*) from u" >"$tmp/$i" ) & done; wait
check "яг 1 курьер авна" 1 "$(cat "$tmp"/* | awk '{s+=$1} END{print s+0}')"; rm -rf "$tmp"
check "ялагч 1 л курьер (ASSIGNED)" 1 "$(val "select count(*) from orders where id='d1' and courier is not null and assign='ASSIGNED'")"

echo "T3b Staff гараар оноох + accept зэрэг (оноолт нь WHERE assign IN ('UNASSIGNED','OFFERED'))"
val "insert into orders(id,status,assign) values ('d2','PAID','OFFERED')" >/dev/null
tmp=$(mktemp -d)
( $P -c "select pg_sleep(0.05); with u as (update orders set courier='cStaff', assign='ASSIGNED' where id='d2' and assign in ('UNASSIGNED','OFFERED') returning 1) select count(*) from u" >"$tmp/a" ) &
( $P -c "select pg_sleep(0.05); with u as (update orders set courier='cAccept', assign='ASSIGNED' where id='d2' and assign='OFFERED' returning 1) select count(*) from u" >"$tmp/b" ) &
wait
check "хоёрын НЭГ нь л ялна" 1 "$(cat "$tmp"/* | awk '{s+=$1} END{print s+0}')"; rm -rf "$tmp"

echo "T4 Дахин оноох: 2 Staff зэрэг (WHERE assign='ASSIGNED' AND courier=<өмнөх>)"
val "insert into orders(id,status,assign,courier) values ('d3','PAID','ASSIGNED','c1')" >/dev/null
tmp=$(mktemp -d)
for c in c2 c3; do ( $P -c "select pg_sleep(0.05); with u as (update orders set courier='$c' where id='d3' and assign='ASSIGNED' and courier='c1' returning 1) select count(*) from u" >"$tmp/$c" ) & done; wait
check "яг 1 нь шилжүүлнэ" 1 "$(cat "$tmp"/* | awk '{s+=$1} END{print s+0}')"; rm -rf "$tmp"

echo "T5 Худалдагчийн олголт: 2 Staff зэрэг (WHERE seller_payout IS NULL)"
val "insert into orders(id,status) values ('s1','PAID')" >/dev/null
tmp=$(mktemp -d)
for k in 1 2; do ( $P -c "select pg_sleep(0.05); with u as (update orders set seller_payout='batch$k' where id='s1' and seller_payout is null returning 1) select count(*) from u" >"$tmp/$k" ) & done; wait
check "яг 1 олголт" 1 "$(cat "$tmp"/* | awk '{s+=$1} END{print s+0}')"; rm -rf "$tmp"

echo "T6 Материалын нөөц: 1000 см², 5 захиалга тус бүр 300 (WHERE stock_cm2 >= 300)"
val "insert into material values ('m1',1000)" >/dev/null
W=$(par 5 "select pg_sleep(0.05); with u as (update material set stock_cm2=stock_cm2-300 where id='m1' and stock_cm2>=300 returning 1) select count(*) from u")
check "яг 3 нь амжилттай" 3 "$W"; check "үлдэгдэл 100, сөрөг биш" 100 "$(val "select stock_cm2 from material where id='m1'")"

echo "T7 Түрээсийн давхар захиалга: нөөц 1, ижил хугацаанд 6 зэрэг (pg_advisory_xact_lock(hashtext(product)) ДОТОР шалгаад нэмнэ)"
DOLOCK="do \$\$ begin perform pg_advisory_xact_lock(hashtext('R1')); if (select count(*) from rental where product='R1' and s < date '2026-03-05' and e > date '2026-03-01') < 1 then perform pg_sleep(0.2); insert into rental(product,s,e) values ('R1','2026-03-01','2026-03-05'); end if; end \$\$"
for i in 1 2 3 4 5 6; do ( $P -c "$DOLOCK" >/dev/null 2>&1 ) & done; wait
check "lock-той: яг 1 захиалга" 1 "$(val "select count(*) from rental where product='R1'")"
echo "T7c (эсрэг шалгалт) lock-гүй бол давхар захиална"
NOLOCK="do \$\$ begin if (select count(*) from rental where product='R2' and s < date '2026-03-05' and e > date '2026-03-01') < 1 then perform pg_sleep(0.2); insert into rental(product,s,e) values ('R2','2026-03-01','2026-03-05'); end if; end \$\$"
for i in 1 2 3 4 5 6; do ( $P -c "$NOLOCK" >/dev/null 2>&1 ) & done; wait
N=$(val "select count(*) from rental where product='R2'")
if [ "$N" -gt 1 ]; then echo "  ✔ lock-гүй үед давхар захиалга гарав (=$N) — lock үнэхээр хэрэгтэйг батлав"; PASS=$((PASS+1)); else echo "  ✖ lock-гүй үед давхар гарсангүй (=$N) — шалгалт мэдрэмжгүй"; FAIL=$((FAIL+1)); fi

echo; echo "ДҮН: өнгөрсөн=$PASS, унасан=$FAIL"
[ "$FAIL" -eq 0 ]
