## 목표
* 주식 거래 운영환경의 transaction data를 db->put() 하는 시나리오를 구현한다.

## 재료
* TPC-E Seed Data의 Trade.txt: `op_trade_bench/Trade.txt` (저장소에는 `data/`에 zstd 압축 조각으로 있고 `data/unpack.sh`로 복원)

## 요구사항
* 생산자: produce_trade_transaction()
* 소비자: rocksdb

* 생산자는 큐에 KV를 넣고 소비자는 큐에서 KV를 가져와 rocksdb에 넣는다.

* 생산자가 소비하는 것: Trade.txt
	- 아래 스키마(Trade.txt에 헤더가 없으므로 컬럼 위치 참고용)를 참고해서 prefix("trade_[t_s_symb]|")를 key, 나머지 행 전부를 value로 하는 KV을 생성하는 함수. 
	- limit를 인자로 받아 생성 개수를 제한하고 limit에 도달하기 전까지 계속 KV를 만들어 낸다.
	- 전체 행 개수가 limit보다 작을 경우 전체 다 돌고 중단하지 않는다  
CREATE TABLE trade (
    t_id           NUMBER(15) NOT NULL,
    t_dts          TIMESTAMP(6) NOT NULL,
    t_st_id        CHAR(4) NOT NULL,
    t_tt_id        CHAR(3) NOT NULL,
    t_is_cash      NUMBER(1) NOT NULL,
    t_s_symb       CHAR(15) NOT NULL,
    t_qty          NUMBER(6) NOT NULL,
    t_bid_price    NUMBER(8,2) NOT NULL,
    t_ca_id        NUMBER(11) NOT NULL,
    t_exec_name    CHAR(49) NOT NULL,
    t_trade_price  NUMBER(8,2),
    t_chrg         NUMBER(10,2) NOT NULL,
    t_comm         NUMBER(10,2) NOT NULL,
    t_tax          NUMBER(10,2) NOT NULL,
    t_lifo         NUMBER(1) NOT NULL,
    CONSTRAINT pk_trade PRIMARY KEY (t_id)
);

* 소비자는 rocksdb 헤더를 include해서 위 함수가 생산한 KV를 큐에서 읽어서 db에 put한다. 

* DB Spec
	- write_buffer_size: 기본값
	- 가변 prefix를 처리할 수 있도록 SliceTransform을 상속해 Transform()과 InDomain()을 직접 구현한다. 
		* 구분자는 |로 한다. 
		* prefix는 구분자 |를 포함한다.
	- use_existing_db=false
	- memtablerep = HEAD(hashinlineskiplist), UPSTREAM, 단일 SKIPLIST(기본 memtable)

* 프로그램 시작 시 시작 측정을 시작하며 모든 KV가 소비되면 시간 측정을 종료해 최종 걸린 시간을 콘솔에 표시한다.
* 프로그램 종료 시 처리량과 지연시간을 콘솔에 표시한다. 
* 프로그램 실행 인자로 --memtable = [HEAD | UPSTREAM | SKIPLIST]를 선택할 수 있게 한다.
